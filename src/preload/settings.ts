import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("settingsApi", {
  read: () => ipcRenderer.invoke("settings:read"),
  update: (patch: unknown) => ipcRenderer.send("settings:update", patch),
  reset: () => ipcRenderer.send("settings:reset"),
  quit: () => ipcRenderer.send("app:quit"),
  close: () => ipcRenderer.send("settings:close"),
  onChanged: (callback: (settings: unknown) => void) => {
    ipcRenderer.on("settings:changed", (_event, settings) => callback(settings));
  },
});
