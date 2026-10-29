/**
 * Auto-update from GitHub Releases (netesh3/webinar, tags desktop-v*), via
 * electron-updater. Off when running unpackaged (npm start) or when
 * WEBINARLIV_DISABLE_UPDATES=1. Checks a few seconds after start and then
 * every four hours; a downloaded update installs when the app quits.
 *
 * macOS only applies updates to a signed app (Squirrel.Mac checks the code
 * signature), so unsigned mac builds log the error and carry on.
 */

import { app, dialog } from "electron";
import { autoUpdater } from "electron-updater";

const INTERVAL_MS = 4 * 60 * 60 * 1000;
let enabled = false;

export function updatesEnabled(): boolean {
  return enabled;
}

export function startAutoUpdates(): void {
  if (!app.isPackaged || process.env.WEBINARLIV_DISABLE_UPDATES === "1") {
    console.log("[updater] disabled (development build or WEBINARLIV_DISABLE_UPDATES)");
    return;
  }
  enabled = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;
  autoUpdater.on("error", (err) => console.warn("[updater]", err?.message ?? err));

  const check = () => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => console.warn("[updater] check failed", err?.message ?? err));
  };
  setTimeout(check, 10_000);
  setInterval(check, INTERVAL_MS).unref();
}

/** "Check for Updates…" in the menu: same check, but tells the user the result. */
export async function checkForUpdatesInteractive(): Promise<void> {
  if (!enabled) {
    await dialog.showMessageBox({
      type: "info",
      message: "Updates are off in this build",
      detail: "Development builds do not update themselves.",
    });
    return;
  }
  try {
    const result = await autoUpdater.checkForUpdates();
    const latest = result?.updateInfo.version;
    if (!result || !result.isUpdateAvailable) {
      await dialog.showMessageBox({
        type: "info",
        message: "Webinar Liv is up to date",
        detail: `Version ${app.getVersion()}`,
      });
    } else {
      await dialog.showMessageBox({
        type: "info",
        message: `Version ${latest} is downloading`,
        detail: "It installs the next time you quit Webinar Liv.",
      });
    }
  } catch (err) {
    await dialog.showMessageBox({
      type: "warning",
      message: "Could not check for updates",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
