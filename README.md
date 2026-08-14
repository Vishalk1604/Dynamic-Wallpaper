# Dynamic Wallpaper

A live Windows wallpaper where **each monitor hosts its own form**, and the forms are coupled to each
other across the gap according to how your monitors are actually arranged in Windows display settings.

Rotate a screen, nudge its vertical offset, make it primary, unplug it — the scene reshapes itself live.
The flow that forms between two screens isn't a decoration painted at a fixed spot: it is aimed at where
your other monitor really is, so moving a display in Windows moves where the wallpaper reaches.

## Styles

Four, switchable from the tray or the settings window. Colour is a separate per-screen setting, so any
style can wear any pair of colours.

| Style | What it looks like |
| --- | --- |
| **Filament** | Hollow shells of discrete particles, joined by a drifting stream |
| **Aether** | Volumetric liquid mist, thick and thin, flowing between screens |
| **Lumen** | One smooth organic body with a hard edge, reaching between screens |
| **Nova** | A dense granular form turning in the dark, over a faint halftone field |
| **Nova II** | Each form draws out toward the next screen until the two strands meet |

Both Nova styles respond to the mouse: each form's rotation eases toward the cursor, and the body
distorts where the cursor rests on it.

Nova II's connection is not a separate object placed in the gap — it is the bodies themselves. Points
on the face turned toward the neighbouring screen are drawn out along the line between the two while
their lateral offset is squeezed toward it, so the strand tapers by construction: thick where it
leaves the form, thin where the two meet. Switch to it and the screens start unconnected, then reach
across over about ten seconds.

## How it works

Every display becomes a rectangle in one coordinate space spanning the whole virtual desktop, in physical
pixels, so a form's position and the reach between screens are expressed in the same units Windows uses
to describe your monitor arrangement. One world unit is one physical pixel; world Y runs opposite screen
Y so the scene shares the desktop's own geometry.

The motion is **kinematic, not a gravity simulation.** An earlier version integrated Plummer-softened
gravity, which looked right for a few minutes and then quietly lost energy until the clouds collapsed
into their own centres. Every fix for that — damping, an orbital thermostat — was another term draining
the system. The shipped model conserves motion by construction: particles reflect elastically off a
hollow shell, and the streams between screens are stateless functions of time, so there is nothing to
drift over a run measured in days.

### Rendering across monitors

A window can only paint the monitor it sits on, so a form drifting toward the next screen has to be
handed over. Rather than shuttle state between processes, every pane renders the **entire** scene
identically and shows only what falls inside its own camera frustum.

Determinism comes from a seeded RNG, a fixed timestep, and a shared epoch — each pane independently
derives the same state from wall-clock time, so they stay in lockstep with no per-frame IPC.

### Cursor tracking

The panes carry `WS_EX_TRANSPARENT` so clicks pass straight through to the desktop, which is what keeps
right-click and icon dragging working. The same flag means **no mouse event ever reaches them**, so the
cursor cannot be read from the renderer. It is polled from the OS with `GetCursorPos` and broadcast to
the panes instead.

## Install

Download the installer from [Releases](https://github.com/Vishalk1604/Dynamic-Wallpaper/releases), or
build it yourself:

```bash
npm install
```

```bash
npm run dist
```

The installer is per-user, so it never asks for an administrator prompt, and writes to `release/`.

Once running the app lives in the system tray — there is no window unless you open Settings. **Quit with
`Ctrl+Alt+Shift+W`** if the tray icon is ever buried in the overflow.

### Requirements

- Windows 10/11, x64
- Node.js 20+ to build (developed against 24.16)

### Development

```bash
npm run dev
```

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `DW_HUD=1` | Overlays per-pane diagnostics: resolution, origin, style, frame rate, GPU |
| `DW_CAPTURE=1` | Renders each pane to a PNG in the user data folder, without minimising your windows |
| `DW_CAPTURE_DELAY=<ms>` | How long to wait before that capture. Styles that build up over time need longer than the 4s default |
| `DW_ADOPT_ICON_HOST=1` | Adopts Explorer's icon host so icons layer above the wallpaper. Off by default — see below |

## Settings

Tray menu for pausing, switching style, and launching at sign-in. The settings window adds a colour
picker per screen and multipliers for density, size, particle size, brightness, flow speed and motion —
settings a style has no use for are hidden rather than left inert.

Settings are written atomically on change and survive an upgrade or reinstall.

## Tuning the shapes

The sliders scale each style; the shapes themselves are constants at the top of the style's own file,
so they can be read and changed without following anything through the code. Edit, `npm run dev`, look.

### Nova II — the connection between screens

In [novaField.ts](src/renderer/wallpaper/gfx/novaField.ts), as GLSL constants above the vertex shader.
All are fractions of the body radius unless noted, and none of them interact:

| Constant | Default | Effect |
| --- | --- | --- |
| `REACH_START` | `0.55` | How much of the body feeds the connection, as a facing cutoff. **Lower is denser** — it is the only supply of material — at the cost of deforming more of the body |
| `REACH_TAPER` | `0.45` | The width it holds through the middle |
| `REACH_NECK` | `0.4` | How much of the trip the narrowing happens over. Raise it and the body ends in a funnel |
| `REACH_HOLD` | `0.3` | Floor under the width at the meeting point. Without it the connection tapers to a wire exactly where the two halves meet, because the points that travel furthest are the ones nearest the pole and they carry almost no lateral offset of their own |
| `REACH_HOLD_MIX` | `0.65` | How firmly that floor is applied. At `1.0` the far end becomes a clean ring |
| `REACH_OVERLAP` | `0.08` | How far past the midpoint each half goes, so the two interpenetrate rather than stopping short |
| `REACH_ARC` | `0.25` | How much it curves. Zero is a straight rod |
| `GROW_SECONDS` | `50` | Seconds to go from separate bodies to a complete connection, scaled by the flow-speed setting |

Two of these are worth understanding before turning them, because they behave differently from how
they read:

- **Density is set by `REACH_START`, not by the width.** The connection is made of the body's own
  points, so widening it spreads the same material thinner. To make it denser, lower the cutoff.
- **`REACH_HOLD` exists because of which points travel.** How far a point goes is decided by how
  squarely it faces the neighbour, so the far end is built from points that started near the pole —
  exactly the ones with no lateral offset to give it width.

### The bodies

`DEFAULT_NOVA_CONFIG` in the same file: `formPoints` (below roughly ten thousand a body stops reading
as a form and starts reading as scattered debris), `ambientPoints`, `radius`, `ambientSpread`. The
stretch ratio and tilt are in the constructor — the stretch has to be pushed well past what looks
right in the numbers, because rotation foreshortens the long axis for most of the cycle.

## Roadmap

- [x] Render surface covering every monitor, pinned beneath all application windows
- [x] Live display topology tracking (rotation, offset, add/remove, primary change, DPI)
- [x] Cross-bezel continuity validation
- [x] Tray icon and settings window
- [x] Five visual styles with per-screen colour
- [x] Cursor interaction
- [x] Installer and launch at sign-in
- [ ] Signed builds

## A note on the wallpaper layer

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
are painted over within a second or two by the renderer's next frame. That mechanism is present behind
`DW_ADOPT_ICON_HOST=1` and is off by default. Full measurements, the geometry fix it needs, and a
safety hazard around it are in [docs/desktop-layer-findings.md](docs/desktop-layer-findings.md).

The surface is therefore a top-level window per monitor, pinned to the bottom of the z-order,
non-activatable, click-through, and absent from the taskbar and Alt+Tab. Every application window draws
above it, the desktop and its icons show through it, and "Show desktop" reveals the desktop over it.

## Licence

MIT — see [LICENSE](LICENSE).

Inspired by [Bjørn Gunnar Staal](https://github.com/bgstaal)'s multi-window 3D scene experiments. No code
from any prior implementation is used here; everything is written from scratch.
