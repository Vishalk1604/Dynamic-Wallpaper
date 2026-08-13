# Getting a render surface onto the Windows desktop

Findings from the Phase 1 spike, on **Windows 11 Home Single Language, build 26200**, Electron 33.2.1.

Recorded because the result was negative in a way that is easy to re-derive badly, and because the
shell hierarchy here differs from most published descriptions of the technique.

## The shell hierarchy on this build

Most write-ups of the "WorkerW trick" describe poking `Progman` with the undocumented message
`0x052C` so Explorer spawns a **top-level** `WorkerW` to host the wallpaper, then locating it as a
sibling of the window that owns `SHELLDLL_DefView`.

That is not the layout here. The wallpaper host is a **direct child of Progman**, and it already
exists before any message is sent:

```
[65930] Progman                    0,0 1920x1080  visible
  ├─ [65942] SHELLDLL_DefView      0,0 1920x1080  visible     <- icon host, above
  │    └─ [65946] SysListView32    0,0 1920x1080  hidden      <- icons (hidden on this machine)
  └─ [656338] WorkerW              0,0 1920x1080  visible     <- wallpaper host, below
```

There are also 14 unrelated top-level `WorkerW` windows, all `136x39` or `0x0`, belonging to other
shell components. Filtering only by class name finds those and misses the real host, so candidates
must be checked against the virtual-screen rect.

Sending `0x052C` with any of the commonly cited parameter pairs — `(0,0)`, `(0xD,0)`, `(0xD,1)`,
`(0xD,0xD)` — returns success and changes nothing, because the host is already present.
`src/main/native/desktopLayer.ts` therefore probes first and only messages the shell if no host is
found.

`GetParent` on a reparented window returns `0`, not the new parent: it only reports a parent for
windows carrying `WS_CHILD`, and returns the *owner* otherwise. A frameless Electron window is
`WS_POPUP`, so readback must use `GetAncestor(hwnd, GA_PARENT)`. Using `GetParent` makes an
attachment watchdog re-attach on every tick forever.

## The blocker: Chromium does not paint once reparented

Reparenting the Electron window into that `WorkerW` succeeds by every structural measure:

- `GetAncestor(child, GA_PARENT)` returns the host
- the window enumerates as a child of the host
- `IsWindowVisible` is true
- its screen rect is exactly the target monitor rect
- it sits below `SHELLDLL_DefView` in z-order, so icons would be preserved

…and nothing is drawn. The desktop shows the plain background colour.

The renderer itself is fine. `webContents.capturePage()` on the attached window returns the fully
correct frame, at the right size, with the right `devicePixelRatio`.

### What was ruled out

| Attempt | Result |
| --- | --- |
| `SetParent` alone | blank |
| Convert `WS_POPUP` → `WS_CHILD` before reparenting | blank |
| Resize by 1px and back to force surface recreation | blank |
| `--disable-gpu-compositing` | blank |
| `--disable-direct-composition` | blank |
| `--disable-features=CalculateNativeWinOcclusion` | blank |
| **Control: identical window, never reparented** | **renders correctly** |

The control matters. Verification is done by screen capture, and this machine's desktop is a solid
black wallpaper (`HKCU\Control Panel\Desktop\WallPaper` empty, background RGB `0 0 0`) with
`HideIcons=1`. A black capture is therefore indistinguishable from "not drawing", so the probe
renderer paints a saturated fill and the control run proves the capture path actually sees it.

Conclusion: on this build, an Electron/Chromium window stops being composited when it ceases to be
top-level. Chromium's presentation path binds to a top-level `HWND`, and reparenting orphans it.
This is a property of Chromium's compositor, not of the attachment logic.

## GDI painting into the desktop is also inert

The obvious next approach is to skip reparenting: render offscreen and blit each frame into the
wallpaper host's device context. That was built and measured, and the throughput is excellent —
**360 frames, 0 failures, 59.7 fps sustained, 1.81 ms per blit** for a full 3000×1920 `StretchDIBits`
with WebGL driving the offscreen surface. Offscreen rendering does keep GPU-accelerated WebGL, so
this part of the idea is sound.

Nothing appeared on screen.

To remove Electron from the question entirely, plain GDI `FillRect` was tried against four
combinations — WorkerW and Progman, each with `GetDC` and with
`GetDCEx(DCX_WINDOW | DCX_CACHE | DCX_LOCKWINDOWUPDATE)`. All four returned success. All four painted
nothing, with the desktop fully exposed via `Shell.MinimizeAll`.

So on this build the desktop background is composited by DWM and the legacy GDI paint targets are
inert. Both classic wallpaper techniques — reparent a window, or draw into the desktop DC — are dead
here, for the same underlying reason.

One aside worth knowing when verifying any of this: `GetDC` clips to a window's **visible region**,
so while ordinary app windows cover the desktop, everything drawn into the wallpaper host is clipped
away and a DC readback returns black. Verification has to expose the desktop first.

## What this build actually allows

An ordinary top-level window renders perfectly — that was the control case throughout. So the
surface stays top-level and is made to behave like wallpaper instead, which is what
`src/main/bottomSurface.ts` does. Verified end state:

```
bottom-most first:
  Program Manager      [Progman]              <- the desktop
  Dynamic Wallpaper    [Chrome_WidgetWin_1]   noactivate=True toolwindow=True
  Dynamic Wallpaper    [Chrome_WidgetWin_1]   noactivate=True toolwindow=True
  Claude               [Chrome_WidgetWin_1]
  ...every other application above
```

Panes land on their exact monitor rects, including the portrait screen at negative coordinates:
`1080x1920@-1080,-534` and `1920x1080@0,0`.

**The honest limitation:** this sits above the real wallpaper, not behind desktop icons. With icons
hidden — as they are on this machine — it is indistinguishable from a true wallpaper. With icons
enabled it would cover them, and "Show desktop" (Win+D) reveals the real desktop over it.

### Three Windows behaviours that cost real time here

**Chromium clamps window size to a work area.** A single window spanning the virtual desktop was the
original design, because one canvas means one simulation and no cross-window coordination. Asking for
3000×1920 produced a 1920×1080 window, at creation and via `SetWindowPos` alike. Per-monitor panes
stay within the limit.

**`resizable: false` pins the clamped size.** It fixes min and max size to whatever the window was
created at, so `SetWindowPos` silently cannot grow it — the portrait pane came out `1080x1080`
instead of `1080x1920`. Panes are therefore created resizable, with `setMinimumSize(1,1)` and
`setMaximumSize(0,0)` to clear inferred constraints, and geometry is asserted and then *verified*
rather than assumed. Nothing can drag them: they are click-through and non-activatable.

**`skipTaskbar: true` does not set `WS_EX_TOOLWINDOW`.** It keeps the pane off the taskbar but leaves
it in Alt+Tab. The ex-style has to be set explicitly, before the window is first shown, because
Windows caches Alt+Tab eligibility at that point.

## No child of the desktop hierarchy composites at all

The natural conclusion from the Chromium failure is that the problem is Chromium-specific, and that
a native render surface — a plain Win32 window presenting Direct3D — would composite correctly as a
child, the way a purpose-built wallpaper engine does it. That would justify installing a C++ or Rust
toolchain to build a presenter addon around Electron's shared-texture offscreen output.

It was worth testing that assumption before paying for it, and it is false.

`charmap.exe` was used as the probe: a classic Win32 dialog (`#32770`), pure GDI, no Chromium and no
DirectComposition anywhere in it. It was converted to `WS_CHILD` and reparented into the desktop
hierarchy, and its geometry verified each time:

| Parent | Z-order position | Rendered? |
| --- | --- | --- |
| WorkerW (child of Progman) | default | no |
| Progman | `HWND_BOTTOM` | no |
| Progman | directly below `SHELLDLL_DefView` | no |

Every case reported `parent` correct via `GetAncestor`, `IsWindowVisible` true, and an exact screen
rect of `300,250 900x650`. Nothing was ever drawn, with the desktop fully exposed and the icons
themselves rendering normally in the same captures.

So this is not a Chromium limitation. **On this build, Windows composites no foreign child window in
the desktop hierarchy** — only Explorer's own `SHELLDLL_DefView` renders. A native presenter addon
would have hit exactly the same wall, so the toolchain install was avoided.

## Adopting the icon host: renders, but loses a repaint race

The one remaining idea that keeps a WebGL renderer is to invert the relationship — rather than place
our surface beneath the icons, `SetParent` Explorer's `SHELLDLL_DefView` into our own top-level pane.
Our pane stays top-level so Chromium composites it, and `DefView` is a plain child window, so it
should draw over our content.

It half works, and the half that fails is decisive.

Getting the geometry right takes two steps. `SetParent` preserves a window's *local* coordinates, so
adopting `DefView` into the primary pane moves it from screen `-1080,-534` to `0,0` on its own.
That is not sufficient, because `DefView` and its `SysListView32` span the whole virtual desktop and
the list view lays icons out at the primary monitor's offset *within* that space — `1080,534` here —
which leaves the icons visibly displaced. Resizing both to the primary monitor's dimensions makes the
list view reflow from its own top-left, and the icons then land correctly.

At which point the icons genuinely render on top of the live WebGL animation. Verified in capture.

They do not stay. The list view paints when invalidated; our renderer paints every frame at ~141 fps.
Within a second or two the renderer has painted over the icons and they are gone — captures at t+4s
and t+12s show them absent. Trying to fix it by forcing a re-layout with `LVM_ARRANGE` makes it
worse: the icons vanish immediately, because that hands the race to the renderer even sooner.

So the icons can be layered above the wallpaper, but not *kept* there, without a way to make the list
view repaint in step with a 60 fps renderer. Continuous forced invalidation would flicker and burn
CPU. The mechanism is left in the codebase behind `DW_ADOPT_ICON_HOST=1`, off by default, since only
the repaint coordination is unsolved.

### Safety hazard worth knowing

Windows destroys child windows with their parent. While `DefView` is adopted it is a child of one of
our panes, so **anything that kills the process without running its shutdown path takes the desktop
icons with it** — `Stop-Process -Force` did exactly that during testing, and the icons stayed gone
until Explorer was restarted.

`IconHost.release()` is therefore wired to `before-quit`, `exit`, `SIGINT`, `SIGTERM` and
`uncaughtException`, and `BottomSurface.dispose()` releases before destroying any pane. None of that
survives a force kill, which is a further reason the feature stays off by default. Recovery is simply
restarting Explorer:

```powershell
Stop-Process -Name explorer -Force
```

**Swap the actual wallpaper image.** Write each frame to disk and call
`SystemParametersInfo(SPI_SETDESKWALLPAPER)`, or use the `IDesktopWallpaper` COM interface. This is
genuinely the wallpaper, behind icons, by definition. It also writes to the registry and forces a
shell repaint per frame, so it is usable at a few frames per second — fine for a slow gradient,
useless for a particle simulation.
