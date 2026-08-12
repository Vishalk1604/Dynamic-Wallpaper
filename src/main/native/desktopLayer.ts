/**
 * Plants windows on the Windows desktop wallpaper layer, behind the desktop icons.
 *
 * There is no documented API for this. The established technique is to poke Progman with an
 * undocumented message (0x052C) so Explorer spawns a "WorkerW" window that hosts the wallpaper,
 * then reparent our own window into it. The shell's window hierarchy differs between Windows
 * versions and builds, so this module probes several message variants and both known hierarchy
 * layouts, and reports which one actually worked instead of assuming.
 *
 * Three layouts are seen in the wild, probed in this order:
 *
 *   A) Windows 11 (confirmed on build 26200): the wallpaper WorkerW is a *direct child* of Progman,
 *      sized to the whole virtual desktop, and sits below its SHELLDLL_DefView sibling. It already
 *      exists before 0x052C is sent. Parenting into it puts us under the icons.
 *
 *   B) Windows 10 era: SHELLDLL_DefView is a child of Progman and the wallpaper WorkerW is a
 *      *top-level* window with no SHELLDLL_DefView child.
 *
 *   C) SHELLDLL_DefView is a child of a top-level WorkerW; the wallpaper host is then the next
 *      top-level WorkerW below that one in z-order.
 *
 * If none yields a usable host we fall back to parenting into Progman at the bottom of its child
 * z-order. Note this fallback is degraded: on layout A an opaque wallpaper WorkerW sibling will
 * paint over us, so `iconsPreserved` being true does not imply we are actually visible.
 */
import {
  FindWindowExW,
  GA_PARENT,
  GetAncestor,
  HWND_BOTTOM,
  IsWindow,
  NULL_HWND,
  SMTO_NORMAL,
  SWP_FRAMECHANGED,
  SWP_NOACTIVATE,
  SWP_NOCOPYBITS,
  SWP_SHOWWINDOW,
  SendMessageTimeoutW,
  SetParent,
  SetWindowPos,
  WM_SPAWN_WORKER,
  findTopLevelWindows,
  makeChildWindow,
  restoreWindowStyle,
  findWindowsOfClass,
  getVirtualScreenRect,
  getWindowRect,
  hasChildOfClass,
  repaintDesktop,
  type Rect,
} from "./win32";

export type HostStrategy =
  | "workerw-child-of-progman"
  | "workerw-sibling-of-progman"
  | "workerw-after-defview"
  | "progman-bottom"
  | "none";

export type WallpaperHost = {
  hwnd: number;
  /** Top-left of the host's coordinate space, in virtual-desktop physical pixels. */
  origin: { x: number; y: number };
  strategy: HostStrategy;
  /** True when desktop icons are expected to remain painted above us. */
  iconsPreserved: boolean;
};

/** wParam / lParam pairs reported to work across different Windows builds. */
const SPAWN_VARIANTS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0x0d, 0],
  [0x0d, 1],
  [0x0d, 0x0d],
];

/** Window styles as they were before we turned each window into a child, keyed by HWND. */
const originalStyles = new Map<number, number>();

const DIAG: string[] = [];

function diag(message: string): void {
  DIAG.push(message);
}

export function takeDiagnostics(): string[] {
  return DIAG.splice(0, DIAG.length);
}

function findProgman(): number {
  return FindWindowExW(NULL_HWND, NULL_HWND, "Progman", null);
}

/** Ask Explorer to create the wallpaper WorkerW. Harmless if one already exists. */
function spawnWorkerW(progman: number): void {
  for (const [wParam, lParam] of SPAWN_VARIANTS) {
    SendMessageTimeoutW(progman, WM_SPAWN_WORKER, wParam, lParam, SMTO_NORMAL, 1000, 0);
  }
}

function coversVirtualScreen(rect: Rect | null, virtual: Rect): boolean {
  if (!rect) return false;
  // Allow a small tolerance; some builds size WorkerW to the primary monitor first and grow it.
  const tolerance = 2;
  return (
    Math.abs(rect.left - virtual.left) <= tolerance &&
    Math.abs(rect.top - virtual.top) <= tolerance &&
    Math.abs(rect.right - virtual.right) <= tolerance &&
    Math.abs(rect.bottom - virtual.bottom) <= tolerance
  );
}

function host(hwnd: number, strategy: HostStrategy, iconsPreserved: boolean): WallpaperHost {
  // GetWindowRect reports screen coordinates even for child windows, and these hosts are
  // borderless, so the window rect origin is also the client origin we position against.
  const rect = getWindowRect(hwnd);
  return {
    hwnd,
    origin: { x: rect?.left ?? 0, y: rect?.top ?? 0 },
    strategy,
    iconsPreserved,
  };
}

/** Try each known shell layout. Returns null if no suitable host exists yet. */
function probe(progman: number, virtual: Rect): WallpaperHost | null {
  // --- Layout A: WorkerW as a direct child of Progman (Windows 11) ---
  const childWorkers = findWindowsOfClass(progman, "WorkerW");
  diag(`WorkerW children of Progman: [${childWorkers.join(", ") || "none"}]`);
  for (const w of childWorkers) {
    const r = getWindowRect(w);
    const covers = coversVirtualScreen(r, virtual);
    diag(
      `  child WorkerW ${w}: rect=${r ? `${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}` : "?"} covers=${covers}`,
    );
    if (covers) {
      diag(`selected WorkerW ${w} (layout A: child of Progman)`);
      return host(w, "workerw-child-of-progman", true);
    }
  }

  const topWorkers = findTopLevelWindows("WorkerW");
  const defViewUnderProgman = hasChildOfClass(progman, "SHELLDLL_DefView");
  diag(`top-level WorkerW windows: [${topWorkers.join(", ") || "none"}]`);
  diag(`SHELLDLL_DefView parented to Progman: ${defViewUnderProgman}`);

  // --- Layout B: icons under Progman, wallpaper in a top-level WorkerW without a DefView ---
  if (defViewUnderProgman) {
    const candidate = topWorkers.find(
      (w) => !hasChildOfClass(w, "SHELLDLL_DefView") && coversVirtualScreen(getWindowRect(w), virtual),
    );
    if (candidate) {
      diag(`selected WorkerW ${candidate} (layout B: sibling of Progman)`);
      return host(candidate, "workerw-sibling-of-progman", true);
    }
    diag("layout B: no full-size top-level WorkerW without DefView");
  }

  // --- Layout C: wallpaper host is the top-level WorkerW just below the one holding the icons ---
  const defViewIndex = topWorkers.findIndex((w) => hasChildOfClass(w, "SHELLDLL_DefView"));
  if (defViewIndex >= 0) {
    for (let i = defViewIndex + 1; i < topWorkers.length; i++) {
      if (coversVirtualScreen(getWindowRect(topWorkers[i]), virtual)) {
        diag(`selected WorkerW ${topWorkers[i]} (layout C: below DefView host ${topWorkers[defViewIndex]})`);
        return host(topWorkers[i], "workerw-after-defview", true);
      }
    }
    diag("layout C: no full-size WorkerW below the DefView host");
  }

  return null;
}

/** Locate a window we can parent into so our content becomes the wallpaper. */
export function findWallpaperHost(): WallpaperHost {
  const virtual = getVirtualScreenRect();
  const progman = findProgman();

  diag(
    `virtual screen: ${virtual.left},${virtual.top} -> ${virtual.right},${virtual.bottom} ` +
      `(${virtual.right - virtual.left}x${virtual.bottom - virtual.top})`,
  );

  if (!progman) {
    diag("Progman not found — Explorer may not be running");
    return { hwnd: NULL_HWND, origin: { x: 0, y: 0 }, strategy: "none", iconsPreserved: false };
  }
  diag(`Progman: ${progman}`);

  // Probe before poking the shell: on Windows 11 the host already exists, so there is no reason
  // to send undocumented messages at all.
  const existing = probe(progman, virtual);
  if (existing) return existing;

  diag("no host found — asking Explorer to spawn one");
  spawnWorkerW(progman);

  const spawned = probe(progman, virtual);
  if (spawned) return spawned;

  // Degraded fallback. On layout A an opaque wallpaper WorkerW sibling will cover us, so this is
  // reported honestly rather than treated as success.
  diag("WARNING: falling back to Progman at bottom of child z-order — content may be hidden");
  return host(progman, "progman-bottom", true);
}

/**
 * Reparent `child` into the wallpaper host and place it over the given virtual-desktop rect.
 * Coordinates are relative to the host's client area, hence the origin subtraction — essential
 * when a monitor sits at negative virtual-desktop coordinates.
 */
export function attachToHost(
  child: number,
  host: WallpaperHost,
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  if (!IsWindow(host.hwnd) || !IsWindow(child)) return false;

  // Must become a real child window, not a reparented popup, or DWM will never composite it.
  if (!originalStyles.has(child)) {
    originalStyles.set(child, makeChildWindow(child));
  }

  SetParent(child, host.hwnd);

  const localX = bounds.x - host.origin.x;
  const localY = bounds.y - host.origin.y;

  const ok = SetWindowPos(
    child,
    HWND_BOTTOM,
    localX,
    localY,
    bounds.width,
    bounds.height,
    SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOCOPYBITS | SWP_FRAMECHANGED,
  );

  // Chromium sizes its composition surface when the window is laid out. Reparenting moves the
  // window without a size change, so nudge the size by a pixel and back to force the surface to be
  // rebuilt against the new parent.
  SetWindowPos(
    child,
    HWND_BOTTOM,
    localX,
    localY,
    bounds.width - 1,
    bounds.height - 1,
    SWP_NOACTIVATE | SWP_NOCOPYBITS,
  );
  SetWindowPos(
    child,
    HWND_BOTTOM,
    localX,
    localY,
    bounds.width,
    bounds.height,
    SWP_NOACTIVATE | SWP_NOCOPYBITS,
  );

  diag(
    `attach child ${child} -> host ${host.hwnd} (${host.strategy}): ` +
      `virtual ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} ` +
      `=> local ${localX},${localY} ok=${ok}`,
  );

  return ok;
}

/** Reposition an already-attached window, e.g. after a display layout change. */
export function repositionChild(
  child: number,
  host: WallpaperHost,
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  if (!IsWindow(host.hwnd) || !IsWindow(child)) return false;
  return SetWindowPos(
    child,
    HWND_BOTTOM,
    bounds.x - host.origin.x,
    bounds.y - host.origin.y,
    bounds.width,
    bounds.height,
    SWP_NOACTIVATE | SWP_NOCOPYBITS,
  );
}

/**
 * True while the child is still parented to the expected host.
 *
 * Uses GetAncestor rather than GetParent: our windows are WS_POPUP, and GetParent reports the
 * owner (0 here) for those, which would make the watchdog re-attach on every tick forever.
 */
export function isAttached(child: number, host: WallpaperHost): boolean {
  return IsWindow(child) && IsWindow(host.hwnd) && GetAncestor(child, GA_PARENT) === host.hwnd;
}

/** Detach so the window can be destroyed without leaving a hole in the desktop. */
export function detachChild(child: number): void {
  if (!IsWindow(child)) {
    originalStyles.delete(child);
    return;
  }
  SetParent(child, NULL_HWND);
  const style = originalStyles.get(child);
  if (style !== undefined) {
    restoreWindowStyle(child, style);
    originalStyles.delete(child);
  }
}

export function restoreDesktop(host: WallpaperHost | null): void {
  repaintDesktop(host?.hwnd ?? NULL_HWND);
}
