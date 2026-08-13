/**
 * Paints frames into the desktop wallpaper layer with GDI.
 *
 * Chromium refuses to composite a window that is not top-level, so the render surface cannot be
 * planted in the shell's WorkerW directly (see docs/desktop-layer-findings.md). Instead frames are
 * rendered offscreen and blitted straight into the WorkerW's device context.
 *
 * This buys three things beyond just working:
 *   - Icons stay on top for free. SHELLDLL_DefView is a *sibling above* WorkerW in Progman's child
 *     z-order, so whatever lands in WorkerW's DC is composited beneath the icons.
 *   - No windows to create, so no window class, no WNDPROC callback and no message pump.
 *   - The DC spans the whole virtual desktop in physical pixels, so one canvas covers every monitor
 *     at 1:1 regardless of per-monitor DPI, and rotation needs no special handling.
 */
import koffi from "koffi";
import { IsWindow } from "./win32";

const gdi32 = koffi.load("gdi32.dll");
const user32 = koffi.load("user32.dll");

const BITMAPINFOHEADER = koffi.struct("BITMAPINFOHEADER", {
  biSize: "uint32",
  biWidth: "int32",
  biHeight: "int32",
  biPlanes: "uint16",
  biBitCount: "uint16",
  biCompression: "uint32",
  biSizeImage: "uint32",
  biXPelsPerMeter: "int32",
  biYPelsPerMeter: "int32",
  biClrUsed: "uint32",
  biClrImportant: "uint32",
});

const GetDC = user32.func("__stdcall", "GetDC", "uintptr_t", ["uintptr_t"]);
const ReleaseDC = user32.func("__stdcall", "ReleaseDC", "int", ["uintptr_t", "uintptr_t"]);

const StretchDIBits = gdi32.func("__stdcall", "StretchDIBits", "int", [
  "uintptr_t", // hdc
  "int", // xDest
  "int", // yDest
  "int", // DestWidth
  "int", // DestHeight
  "int", // xSrc
  "int", // ySrc
  "int", // SrcWidth
  "int", // SrcHeight
  "void *", // lpBits
  koffi.pointer(BITMAPINFOHEADER), // lpbmi
  "uint", // iUsage
  "uint32", // rop
]);

const SetStretchBltMode = gdi32.func("__stdcall", "SetStretchBltMode", "int", ["uintptr_t", "int"]);

const DIB_RGB_COLORS = 0;
const SRCCOPY = 0x00cc0020;
/** Best quality downscale/upscale; matters because frames may be rendered below native resolution. */
const HALFTONE = 4;

export type BlitTarget = {
  /** Destination rect in virtual-desktop physical pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Blit a top-down BGRA frame into the wallpaper host's DC.
 *
 * `source` must be `sourceWidth * sourceHeight * 4` bytes, which is exactly what
 * `NativeImage.getBitmap()` returns. A negative `biHeight` marks the DIB as top-down so no row
 * flipping is needed.
 */
export function blitToHost(
  hostHwnd: number,
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  target: BlitTarget,
  hostOrigin: { x: number; y: number },
): boolean {
  if (!hostHwnd || !IsWindow(hostHwnd)) return false;
  if (sourceWidth <= 0 || sourceHeight <= 0) return false;

  const expected = sourceWidth * sourceHeight * 4;
  if (source.length < expected) return false;

  const header = {
    biSize: 40,
    biWidth: sourceWidth,
    biHeight: -sourceHeight, // negative => top-down rows, matching getBitmap()
    biPlanes: 1,
    biBitCount: 32,
    biCompression: 0, // BI_RGB
    biSizeImage: 0,
    biXPelsPerMeter: 0,
    biYPelsPerMeter: 0,
    biClrUsed: 0,
    biClrImportant: 0,
  };

  const hdc = GetDC(hostHwnd);
  if (!hdc) return false;

  try {
    if (sourceWidth !== target.width || sourceHeight !== target.height) {
      SetStretchBltMode(hdc, HALFTONE);
    }
    const written = StretchDIBits(
      hdc,
      target.x - hostOrigin.x,
      target.y - hostOrigin.y,
      target.width,
      target.height,
      0,
      0,
      sourceWidth,
      sourceHeight,
      source,
      header,
      DIB_RGB_COLORS,
      SRCCOPY,
    );
    return written > 0;
  } finally {
    ReleaseDC(hostHwnd, hdc);
  }
}
