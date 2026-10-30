/** Preload for the always-on-top Stop-share bar (static/share-bar.html). */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("shareBar", {
  stop() {
    ipcRenderer.send("share-bar:stop");
  },
});
