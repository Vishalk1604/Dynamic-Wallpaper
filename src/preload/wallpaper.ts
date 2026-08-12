import { contextBridge, ipcRenderer } from "electron";

export type WallpaperBridge = {
  onDisplay: (callback: (display: unknown) => void) => void;
};

const bridge: WallpaperBridge = {
  onDisplay: (callback) => {
    ipcRenderer.on("wallpaper:display", (_event, display) => callback(display));
  },
};

contextBridge.exposeInMainWorld("wallpaper", bridge);
