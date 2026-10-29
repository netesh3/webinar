/**
 * Keeps the display awake while a call is active.
 *
 * Each window's preload reports whether it is "in a call" (see preload.ts for
 * how that is detected). While any window reports true, one
 * powerSaveBlocker("prevent-display-sleep") is held; it is released when the
 * last one reports false or closes.
 */

import { ipcMain, powerSaveBlocker } from "electron";
import { isSiteUrl } from "./config";

const active = new Set<number>();
let blockerId: number | null = null;

function update(): void {
  if (active.size > 0 && blockerId === null) {
    blockerId = powerSaveBlocker.start("prevent-display-sleep");
  } else if (active.size === 0 && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

export function setCallActive(contentsId: number, on: boolean): void {
  if (on) active.add(contentsId);
  else active.delete(contentsId);
  update();
}

export function isCallActive(): boolean {
  return active.size > 0;
}

export function registerPowerIpc(): void {
  ipcMain.on("webinarliv:call-active", (event, on: unknown) => {
    if (!isSiteUrl(event.senderFrame?.url ?? "")) return;
    const id = event.sender.id;
    if (on === true && !active.has(id)) {
      // Drop the flag when this page goes away without saying so.
      const clear = () => setCallActive(id, false);
      event.sender.once("destroyed", clear);
      // did-navigate is main-frame, cross-document only: the page that set
      // the flag is gone. (In-page route changes keep the page script alive,
      // and it reports false itself.)
      event.sender.once("did-navigate", clear);
    }
    setCallActive(id, on === true);
  });
}
