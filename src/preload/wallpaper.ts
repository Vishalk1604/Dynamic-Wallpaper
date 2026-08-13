import { contextBridge, ipcRenderer } from "electron";

export type WallpaperBridge = {
  onLayout: (callback: (layout: unknown) => void) => void;
};

const bridge: WallpaperBridge = {
  onLayout: (callback) => {
    ipcRenderer.on("wallpaper:layout", (_event, layout) => callback(layout));
  },
};

contextBridge.exposeInMainWorld("wallpaper", bridge);
