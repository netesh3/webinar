/**
 * Keeps the machine awake and the process favoured while a call is active.
 *
 * Each window's preload reports whether it is "in a call" (see preload.ts for
 * how that is detected). While any window reports true:
 *   - powerSaveBlocker("prevent-display-sleep") so the screen does not blank
 *   - powerSaveBlocker("prevent-app-suspension") so the OS does not freeze
 *     the process when the lid is half-closed or the window is in the background
 *   - process priority ABOVE_NORMAL (qos.ts)
 * Released when the last window reports false or closes.
 */

import { ipcMain, powerSaveBlocker } from "electron";
import { isSiteUrl } from "./config";
import { applyCallProcessPriority } from "./qos";
import { senderUrl } from "./security";

const active = new Set<number>();
let displayBlockerId: number | null = null;
let appBlockerId: number | null = null;

function startBlocker(type: "prevent-display-sleep" | "prevent-app-suspension"): number {
  return powerSaveBlocker.start(type);
}

function stopBlocker(id: number | null): void {
  if (id !== null && powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
}

function update(): void {
  const on = active.size > 0;
  if (on) {
    displayBlockerId ??= startBlocker("prevent-display-sleep");
    appBlockerId ??= startBlocker("prevent-app-suspension");
  } else {
    stopBlocker(displayBlockerId);
    stopBlocker(appBlockerId);
    displayBlockerId = null;
    appBlockerId = null;
  }
  applyCallProcessPriority(on);
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
    if (!isSiteUrl(senderUrl(event))) return;
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
