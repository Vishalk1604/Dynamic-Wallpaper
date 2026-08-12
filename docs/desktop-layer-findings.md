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

## Viable approaches

**Bottom-most top-level window.** Keep the window top-level so Chromium keeps compositing — the
control case, already proven to work — and make it behave like a wallpaper: `WS_EX_NOACTIVATE` and
`WS_EX_TOOLWINDOW` so it never takes focus and stays out of Alt+Tab and the taskbar, click-through
so the desktop stays usable, and pinned to the bottom of the z-order with re-assertion when other
windows activate. Every ordinary window then renders above it. Deviations from a true wallpaper:
"Show desktop" (Win+D) reveals the real desktop over it, and it would cover desktop icons if they
were ever re-enabled.

**Offscreen render, then blit.** Run the renderer with `offscreen: true`, take each frame from the
`paint` event, and draw it into the `WorkerW` device context with GDI from the main process. This
yields a genuine wallpaper behind icons, at the cost of a per-frame full-resolution copy for every
monitor and materially more CPU.

**Native render surface.** A plain Win32 window drawing with OpenGL or Direct3D has no such
top-level dependency and composites correctly as a child. This means not using Electron for the
wallpaper surface, which needs a C++ or Rust toolchain that is not installed on this machine.
