/** Preload for the local screen-share picker window (static/picker.html). */

import { contextBridge, ipcRenderer } from "electron";

export interface PickerSource {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string;
  icon: string | null;
}

export interface PickerInit {
  sources: PickerSource[];
  /** System audio can be offered (Windows loopback, and the page asked for audio). */
  audioAvailable: boolean;
  /** macOS screen-recording permission is not granted yet. */
  needsScreenPermission: boolean;
  platform: string;
}

contextBridge.exposeInMainWorld("picker", {
  onInit(callback: (init: PickerInit) => void) {
    ipcRenderer.on("picker:init", (_event, init: PickerInit) => callback(init));
  },
  choose(id: string, audio: boolean) {
    ipcRenderer.send("picker:choose", { id: String(id), audio: audio === true });
  },
  cancel() {
    ipcRenderer.send("picker:cancel");
  },
  openScreenSettings() {
    ipcRenderer.send("picker:open-screen-settings");
  },
});
