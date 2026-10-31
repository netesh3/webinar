/**
 * Entire-screen share: hide every site window and show a Stop bar that is
 * excluded from capture (setContentProtection). Restores on stop / track end.
 */

import { BrowserWindow, ipcMain, screen, type WebContents } from "electron";
import path from "node:path";
import { closeExtraRoomDecision, isOwnCaptureSource, shareBarBounds, shouldHideAppWindows } from "./share-policy";
import { isSiteUrl } from "./config";
import { senderUrl } from "./security";

type Hidden = { win: BrowserWindow; visible: boolean; minimized: boolean };

let overlay: BrowserWindow | null = null;
let hidden: Hidden[] = [];
let sharingContents: WebContents | null = null;
let restoreTimer: ReturnType<typeof setTimeout> | null = null;

function staticPath(file: string): string {
  return path.join(__dirname, "..", "static", file);
}

function ourMediaSourceIds(): Set<string> {
  const ids = new Set<string>();
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      ids.add(win.getMediaSourceId());
    } catch {
      // Unavailable on this window.
    }
  }
  return ids;
}

/** Window sources that belong to this app, so the picker does not offer them. */
export function filterOwnWindowSources<T extends { id: string; name: string; kind: "screen" | "window" }>(
  sources: readonly T[],
): T[] {
  const ours = ourMediaSourceIds();
  return sources.filter((s) => !isOwnCaptureSource(s, ours));
}

export function isShareSessionActive(): boolean {
  return overlay !== null && !overlay.isDestroyed();
}

export function focusShareBar(): void {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.showInactive();
  overlay.moveTop();
}

function clearRestoreTimer(): void {
  if (restoreTimer !== null) {
    clearTimeout(restoreTimer);
    restoreTimer = null;
  }
}

function createOverlay(): BrowserWindow {
  const bounds = shareBarBounds(screen.getPrimaryDisplay().workArea);
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    show: false,
    title: "Sharing — Webinar Liv",
    backgroundColor: "#00000000",
    hasShadow: true,
    ...(process.platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, "share-bar-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "screen-saver");
  if (typeof win.setVisibleOnAllWorkspaces === "function") {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  // Excluded from the capture on macOS and on Windows 10 2004+ (WDA_EXCLUDEFROMCAPTURE).
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  return win;
}

function hideOthers(except: BrowserWindow): void {
  const known = new Set(hidden.map((h) => h.win));
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === except || win.isDestroyed()) continue;
    if (!known.has(win)) {
      hidden.push({ win, visible: win.isVisible(), minimized: win.isMinimized() });
    }
    if (win.isVisible() || win.isMinimized()) win.hide();
  }
}

function restoreHidden(skip?: BrowserWindow | null): void {
  for (const rec of hidden) {
    if (rec.win.isDestroyed() || rec.win === skip) continue;
    if (rec.minimized) rec.win.minimize();
    else if (rec.visible) rec.win.show();
  }
  hidden = [];
}

export function endShareSession(opts?: { closing?: BrowserWindow | null }): void {
  clearRestoreTimer();
  const bar = overlay;
  overlay = null;
  sharingContents = null;
  restoreHidden(opts?.closing ?? null);
  if (bar && !bar.isDestroyed()) {
    bar.removeAllListeners("closed");
    bar.close();
  }
}

function requestStop(): void {
  const contents = sharingContents;
  if (contents && !contents.isDestroyed()) {
    contents.send("webinarliv:stop-share");
  }
  // If the page never stops the capture, still restore so the host is not stuck.
  clearRestoreTimer();
  restoreTimer = setTimeout(() => endShareSession(), 4000);
}

export function beginShareSession(from: WebContents | null, sourceKind: "screen" | "window"): void {
  if (!shouldHideAppWindows(sourceKind)) {
    if (isShareSessionActive()) endShareSession();
    return;
  }
  if (from && from.isDestroyed()) from = null;
  sharingContents = from;

  if (overlay && !overlay.isDestroyed()) {
    hideOthers(overlay);
    overlay.showInactive();
    overlay.moveTop();
    return;
  }

  const win = createOverlay();
  overlay = win;
  hideOthers(win);

  const onClosed = () => {
    if (overlay === win) requestStop();
  };
  win.on("closed", onClosed);
  if (from) {
    from.once("destroyed", () => {
      if (sharingContents === from) endShareSession();
    });
  }

  win.webContents.once("did-finish-load", () => {
    if (win.isDestroyed() || overlay !== win) return;
    win.showInactive();
    win.moveTop();
  });
  void win.loadFile(staticPath("share-bar.html"));
}

export function onShareCaptureEnded(contents: WebContents): void {
  if (sharingContents && contents !== sharingContents) return;
  endShareSession();
}

export function closeExtraRoomWindow(
  sender: WebContents,
  mainWindow: BrowserWindow | null,
  resultsUrl: string,
): boolean {
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) return false;
  const senderIsMain = !!mainWindow && !mainWindow.isDestroyed() && win === mainWindow;
  const resultsUrlOk = isSiteUrl(resultsUrl);
  const decision = closeExtraRoomDecision({ senderIsMain, resultsUrlOk });
  if (!decision.closeSender) return false;
  endShareSession({ closing: win });
  if (decision.loadResultsInMain && mainWindow && !mainWindow.isDestroyed()) {
    void mainWindow.loadURL(resultsUrl);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  win.close();
  return true;
}

export function registerShareIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.on("share-bar:stop", (event) => {
    if (!overlay || overlay.isDestroyed() || event.sender !== overlay.webContents) return;
    requestStop();
  });
  ipcMain.on("webinarliv:share-capture-ended", (event) => {
    if (!isSiteUrl(senderUrl(event))) return;
    onShareCaptureEnded(event.sender);
  });
  ipcMain.handle("webinarliv:close-room", (event, url: unknown) => {
    if (!isSiteUrl(senderUrl(event))) return false;
    if (typeof url !== "string" || !isSiteUrl(url)) return false;
    return closeExtraRoomWindow(event.sender, getMainWindow(), url);
  });
}
