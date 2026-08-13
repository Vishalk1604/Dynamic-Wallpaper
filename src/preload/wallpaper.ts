import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("wallpaper", {
  onLayout: (callback: (payload: unknown) => void) => {
    ipcRenderer.on("wallpaper:layout", (_event, payload) => callback(payload));
  },
  onSettings: (callback: (settings: unknown) => void) => {
    ipcRenderer.on("wallpaper:settings", (_event, settings) => callback(settings));
  },
});
