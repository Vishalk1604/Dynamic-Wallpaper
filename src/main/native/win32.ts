/**
 * Minimal Win32 bindings needed to plant a window on the desktop wallpaper layer.
 *
 * Handles are passed as `uintptr_t` rather than koffi pointer objects: an HWND is just a
 * pointer-sized integer, so this keeps them comparable and storable as plain numbers.
 * Window handles come out of a per-session table and in practice sit far below 2^53, but
 * `toHandle` asserts that rather than trusting it silently.
 */
import koffi from "koffi";

const user32 = koffi.load("user32.dll");

const RECT = koffi.struct("RECT", {
  left: "long",
  top: "long",
  right: "long",
  bottom: "long",
});

export const FindWindowExW = user32.func("__stdcall", "FindWindowExW", "uintptr_t", [
  "uintptr_t", // hWndParent
  "uintptr_t", // hWndChildAfter
  "str16", // lpszClass
  "str16", // lpszWindow
]);

export const SendMessageW = user32.func("__stdcall", "SendMessageW", "intptr_t", [
  "uintptr_t", // hWnd
  "uint", // Msg
  "uintptr_t", // wParam
  "intptr_t", // lParam
]);

/** LVM_ARRANGE — re-runs a list view's icon layout and repaints it. */
export const LVM_ARRANGE = 0x1000 + 22;
export const LVA_DEFAULT = 0x0000;

export const SendMessageTimeoutW = user32.func("__stdcall", "SendMessageTimeoutW", "intptr_t", [
  "uintptr_t", // hWnd
  "uint", // Msg
  "uintptr_t", // wParam
  "intptr_t", // lParam
  "uint", // fuFlags
  "uint", // uTimeout
  "uintptr_t", // lpdwResult (NULL)
]);

export const SetParent = user32.func("__stdcall", "SetParent", "uintptr_t", [
  "uintptr_t", // hWndChild
  "uintptr_t", // hWndNewParent
]);

export const GetParent = user32.func("__stdcall", "GetParent", "uintptr_t", ["uintptr_t"]);

/**
 * GetParent only reports a parent for windows carrying WS_CHILD; for a WS_POPUP window (which is
 * what a frameless Electron window is) it returns the owner, or 0. SetParent still reparents such
 * a window successfully, so GetAncestor(GA_PARENT) is the only reliable way to read it back.
 */
export const GetAncestor = user32.func("__stdcall", "GetAncestor", "uintptr_t", ["uintptr_t", "uint"]);

export const GA_PARENT = 1;

export const SetWindowPos = user32.func("__stdcall", "SetWindowPos", "bool", [
  "uintptr_t", // hWnd
  "uintptr_t", // hWndInsertAfter
  "int", // X
  "int", // Y
  "int", // cx
  "int", // cy
  "uint", // uFlags
]);

export const GetWindowRect = user32.func("__stdcall", "GetWindowRect", "bool", [
  "uintptr_t",
  koffi.out(koffi.pointer(RECT)),
]);

export const GetSystemMetrics = user32.func("__stdcall", "GetSystemMetrics", "int", ["int"]);

export const GetWindowLongPtrW = user32.func("__stdcall", "GetWindowLongPtrW", "intptr_t", [
  "uintptr_t",
  "int",
]);

export const SetWindowLongPtrW = user32.func("__stdcall", "SetWindowLongPtrW", "intptr_t", [
  "uintptr_t",
  "int",
  "intptr_t",
]);

export const IsWindow = user32.func("__stdcall", "IsWindow", "bool", ["uintptr_t"]);

export const IsWindowVisible = user32.func("__stdcall", "IsWindowVisible", "bool", ["uintptr_t"]);

export const InvalidateRect = user32.func("__stdcall", "InvalidateRect", "bool", [
  "uintptr_t", // hWnd
  "uintptr_t", // lpRect (NULL for whole window)
  "bool", // bErase
]);

export const UpdateWindow = user32.func("__stdcall", "UpdateWindow", "bool", ["uintptr_t"]);

export const RedrawWindow = user32.func("__stdcall", "RedrawWindow", "bool", [
  "uintptr_t", // hWnd
  "uintptr_t", // lprcUpdate (NULL)
  "uintptr_t", // hrgnUpdate (NULL)
  "uint", // flags
]);

export const SystemParametersInfoW = user32.func("__stdcall", "SystemParametersInfoW", "bool", [
  "uint", // uiAction
  "uint", // uiParam
  "uintptr_t", // pvParam
  "uint", // fWinIni
]);

// --- constants -------------------------------------------------------------

/** Undocumented Progman message that makes Explorer spawn the wallpaper WorkerW. */
export const WM_SPAWN_WORKER = 0x052c;

export const SMTO_NORMAL = 0x0000;

export const SWP_NOSIZE = 0x0001;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOZORDER = 0x0004;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_FRAMECHANGED = 0x0020;
export const SWP_SHOWWINDOW = 0x0040;
export const SWP_NOCOPYBITS = 0x0100;

export const GWL_STYLE = -16;
export const GWL_EXSTYLE = -20;

export const WS_CHILD = 0x40000000;
export const WS_POPUP = 0x80000000;

export const WS_EX_TOOLWINDOW = 0x00000080;
export const WS_EX_NOACTIVATE = 0x08000000;

/**
 * Keep a window out of Alt+Tab and the taskbar, and stop it ever taking activation.
 *
 * Electron's `skipTaskbar` alone does not set WS_EX_TOOLWINDOW on this build, which leaves the
 * window listed in Alt+Tab. Must be called before the window is first shown, since Windows caches
 * Alt+Tab eligibility when a window becomes visible.
 */
export function makeToolWindow(hwnd: number): void {
  const previous = Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) >>> 0;
  const next = (previous | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) >>> 0;
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
}

/**
 * Convert a WS_POPUP window into a genuine WS_CHILD.
 *
 * SetParent alone leaves a popup in a half-reparented state: it reports the new parent but DWM
 * never composites its content into the parent's visual tree, so it stays invisible. Swapping the
 * style makes it a real child window. Returns the previous style so it can be restored on detach.
 */
export function makeChildWindow(hwnd: number): number {
  const previous = Number(GetWindowLongPtrW(hwnd, GWL_STYLE)) >>> 0;
  const next = ((previous & ~WS_POPUP) | WS_CHILD) >>> 0;
  SetWindowLongPtrW(hwnd, GWL_STYLE, next);
  return previous;
}

export function restoreWindowStyle(hwnd: number, style: number): void {
  SetWindowLongPtrW(hwnd, GWL_STYLE, style >>> 0);
}

export const HWND_BOTTOM = 1;

export const SM_XVIRTUALSCREEN = 76;
export const SM_YVIRTUALSCREEN = 77;
export const SM_CXVIRTUALSCREEN = 78;
export const SM_CYVIRTUALSCREEN = 79;

export const RDW_INVALIDATE = 0x0001;
export const RDW_ERASE = 0x0004;
export const RDW_ALLCHILDREN = 0x0080;
export const RDW_UPDATENOW = 0x0100;

export const SPI_SETDESKWALLPAPER = 0x0014;
export const SPIF_UPDATEINIFILE = 0x0001;
export const SPIF_SENDCHANGE = 0x0002;

// --- helpers ---------------------------------------------------------------

export const NULL_HWND = 0;

export type Rect = { left: number; top: number; right: number; bottom: number };

/** Convert the Buffer from Electron's `getNativeWindowHandle()` into an integer HWND. */
export function toHandle(buffer: Buffer): number {
  const value = buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0));
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`HWND ${value} exceeds safe integer range`);
  }
  return Number(value);
}

export function getWindowRect(hwnd: number): Rect | null {
  const rect: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
  return GetWindowRect(hwnd, rect) ? rect : null;
}

/** Bounding box of all monitors, in physical pixels. Origin is negative when a monitor sits left of / above primary. */
export function getVirtualScreenRect(): Rect {
  const left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  const top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  return {
    left,
    top,
    right: left + GetSystemMetrics(SM_CXVIRTUALSCREEN),
    bottom: top + GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

/**
 * Iterate windows of a given class under `parent`, in z-order (topmost first).
 * Pass NULL_HWND as the parent for top-level windows. Avoids needing an EnumWindows callback.
 */
export function findWindowsOfClass(parent: number, className: string): number[] {
  const found: number[] = [];
  let hwnd = NULL_HWND;
  // Guard against a pathological loop if the shell is in a strange state.
  for (let i = 0; i < 256; i++) {
    hwnd = FindWindowExW(parent, hwnd, className, null);
    if (!hwnd) break;
    found.push(hwnd);
  }
  return found;
}

/** Top-level windows of a given class, in z-order. */
export function findTopLevelWindows(className: string): number[] {
  return findWindowsOfClass(NULL_HWND, className);
}

export function hasChildOfClass(parent: number, className: string): boolean {
  return FindWindowExW(parent, NULL_HWND, className, null) !== NULL_HWND;
}

/** Ask Windows to repaint the desktop, clearing any residue we left behind. */
export function repaintDesktop(hostHwnd: number): void {
  if (hostHwnd && IsWindow(hostHwnd)) {
    RedrawWindow(hostHwnd, 0, 0, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);
  }
  // Re-apply the wallpaper from the registry so the real background is restored.
  SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, 0, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE);
}
