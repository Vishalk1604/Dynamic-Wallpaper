/**
 * Puts the live wallpaper genuinely behind the desktop icons.
 *
 * Windows 11 build 26200 composites no foreign child window in the desktop hierarchy, so a surface
 * cannot be placed underneath the icons (see docs/desktop-layer-findings.md). This inverts the
 * relationship instead: Explorer's icon host, `SHELLDLL_DefView`, is reparented into our own
 * top-level pane. Our pane stays top-level so Chromium keeps compositing it, and `DefView` is a
 * plain child window that draws over our content with its background transparent — so the icons
 * appear above the animation, which is exactly the wanted result.
 *
 * Two details make it work correctly rather than approximately:
 *
 *   - `DefView` and its `SysListView32` span the whole virtual desktop, and the list view lays icons
 *     out at the primary monitor's offset *within* that space (1080,534 for this setup). Simply
 *     reparenting therefore leaves the icons visibly displaced. Resizing both to the primary
 *     monitor's dimensions makes the list view reflow from its own top-left, which lands the icons
 *     where they belong.
 *
 *   - Windows destroys child windows along with their parent. If a pane were destroyed while it
 *     still owned `DefView`, the desktop icons would be destroyed with it and stay gone until
 *     Explorer restarted. Release therefore has to happen before any pane is torn down, and is
 *     wired to several exit paths for safety.
 */
import type { Bounds } from "./displays";
import {
  FindWindowExW,
  GA_PARENT,
  GetAncestor,
  InvalidateRect,
  IsWindow,
  NULL_HWND,
  SWP_NOACTIVATE,
  SWP_NOZORDER,
  SWP_SHOWWINDOW,
  SetParent,
  SetWindowPos,
  UpdateWindow,
  getWindowRect,
} from "./native/win32";

type AdoptedState = {
  defView: number;
  listView: number;
  /** Where to put things back: Progman, and the rect DefView occupied within it. */
  progman: number;
  restoreWidth: number;
  restoreHeight: number;
};

export class IconHost {
  private state: AdoptedState | null = null;

  get isAdopted(): boolean {
    return this.state !== null;
  }

  private static findProgman(): number {
    return FindWindowExW(NULL_HWND, NULL_HWND, "Progman", null);
  }

  /**
   * Locate the icon host wherever it currently lives — under Progman normally, or under one of our
   * own panes if a previous run left it adopted.
   */
  private static findDefView(paneHwnds: number[]): number {
    const progman = IconHost.findProgman();
    if (progman) {
      const direct = FindWindowExW(progman, NULL_HWND, "SHELLDLL_DefView", null);
      if (direct) return direct;
    }
    for (const pane of paneHwnds) {
      if (!IsWindow(pane)) continue;
      const nested = FindWindowExW(pane, NULL_HWND, "SHELLDLL_DefView", null);
      if (nested) return nested;
    }
    return NULL_HWND;
  }

  /**
   * Reparent the icon host into `paneHwnd` and size it to that monitor.
   * `virtualBounds` is remembered so the original geometry can be restored exactly.
   */
  adopt(paneHwnd: number, paneRegion: Bounds, virtualBounds: Bounds): boolean {
    if (this.state) return true;
    if (!IsWindow(paneHwnd)) return false;

    const progman = IconHost.findProgman();
    const defView = IconHost.findDefView([paneHwnd]);
    if (!progman || !defView) {
      console.warn(`icon host not found (progman=${progman}, defView=${defView})`);
      return false;
    }

    const listView = FindWindowExW(defView, NULL_HWND, "SysListView32", null);

    SetParent(defView, paneHwnd);

    // Resize both so the list view reflows its icons from the pane's top-left.
    const flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOZORDER;
    SetWindowPos(defView, NULL_HWND, 0, 0, paneRegion.width, paneRegion.height, flags);
    if (listView) {
      SetWindowPos(listView, NULL_HWND, 0, 0, paneRegion.width, paneRegion.height, flags);
    }

    // Deliberately no LVM_ARRANGE and no erasing invalidate here. Both were tried: LVM_ARRANGE made
    // the icons disappear entirely, because whether they are visible depends on the list view having
    // painted more recently than our renderer, and forcing a re-layout hands that race to the
    // renderer. The plain resize is the only variant observed to leave icons drawn. See the
    // stability caveat in docs/desktop-layer-findings.md.

    this.state = {
      defView,
      listView,
      progman,
      restoreWidth: virtualBounds.width,
      restoreHeight: virtualBounds.height,
    };

    const rect = getWindowRect(defView);
    console.log(
      `icon host adopted into pane ${paneHwnd}: parent=${GetAncestor(defView, GA_PARENT)} ` +
        `rect=${rect ? `${rect.left},${rect.top} ${rect.right - rect.left}x${rect.bottom - rect.top}` : "?"}`,
    );
    return true;
  }

  /**
   * Hand the icon host back to Explorer at its original geometry.
   * Safe to call repeatedly, and safe to call when nothing was adopted.
   */
  release(): void {
    const state = this.state;
    if (!state) return;
    this.state = null;

    // Re-resolve Progman: Explorer may have restarted while we held the icon host.
    const progman = IsWindow(state.progman) ? state.progman : IconHost.findProgman();
    if (!progman || !IsWindow(state.defView)) {
      console.error("could not release icon host; restart Explorer to restore desktop icons");
      return;
    }

    SetParent(state.defView, progman);
    const flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOZORDER;
    SetWindowPos(state.defView, NULL_HWND, 0, 0, state.restoreWidth, state.restoreHeight, flags);
    if (state.listView && IsWindow(state.listView)) {
      SetWindowPos(state.listView, NULL_HWND, 0, 0, state.restoreWidth, state.restoreHeight, flags);
    }
    // Repainting on the way out is safe and wanted: Explorer owns the surface again, so this is what
    // puts the icons back where the user expects them.
    InvalidateRect(progman, NULL_HWND, true);
    UpdateWindow(progman);

    const rect = getWindowRect(state.defView);
    console.log(
      `icon host released: parent=${GetAncestor(state.defView, GA_PARENT)} (progman=${progman}) ` +
        `rect=${rect ? `${rect.left},${rect.top} ${rect.right - rect.left}x${rect.bottom - rect.top}` : "?"}`,
    );
  }
}
