/**
 * Screen sharing. Electron has no built-in picker for getDisplayMedia, so the
 * session's display-media handler lists screens and windows with
 * desktopCapturer and shows them in a small modal window
 * (static/picker.html). On Windows, when the page asked for audio, the picker
 * also offers system audio (WASAPI loopback).
 */

import {
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  shell,
  systemPreferences,
  webContents as allWebContents,
  type Session,
  type Streams,
  type WebContents,
} from "electron";
import path from "node:path";
import { isSiteOrigin } from "./config";
import type { PickerInit, PickerSource } from "./picker-preload";
import { beginShareSession, filterOwnWindowSources } from "./share-session";

let pickerOpen = false;

function staticPath(file: string): string {
  return path.join(__dirname, "..", "static", file);
}

function screenPermissionMissing(): boolean {
  if (process.platform !== "darwin") return false;
  return systemPreferences.getMediaAccessStatus("screen") !== "granted";
}

async function listSources(): Promise<PickerSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });
  const mapped: PickerSource[] = sources.map((s) => ({
    id: s.id,
    name: s.name || (s.id.startsWith("screen:") ? "Screen" : "Window"),
    kind: s.id.startsWith("screen:") ? ("screen" as const) : ("window" as const),
    thumbnail: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
    icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  }));
  return filterOwnWindowSources(mapped);
}

/** Shows the picker and resolves with the chosen streams, or null if cancelled. */
async function pick(
  parent: BrowserWindow | null,
  audioRequested: boolean,
  from: WebContents | null,
): Promise<Streams | null> {
  const sources = await listSources();
  const audioAvailable = audioRequested && process.platform === "win32";

  const win = new BrowserWindow({
    width: 760,
    height: 560,
    minWidth: 520,
    minHeight: 400,
    parent: parent ?? undefined,
    modal: !!parent,
    show: false,
    title: "Share your screen",
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "picker-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  return new Promise<Streams | null>((resolve) => {
    let settled = false;
    const finish = (result: Streams | null) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("picker:choose", onChoose);
      ipcMain.removeListener("picker:cancel", onCancel);
      ipcMain.removeListener("picker:open-screen-settings", onSettings);
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };
    const fromPicker = (e: Electron.IpcMainEvent) => !win.isDestroyed() && e.sender === win.webContents;

    const onChoose = (e: Electron.IpcMainEvent, choice: { id: string; audio: boolean }) => {
      if (!fromPicker(e)) return;
      const source = sources.find((s) => s.id === choice?.id);
      if (!source) return finish(null);
      const streams: Streams = { video: { id: source.id, name: source.name } };
      if (audioAvailable && choice.audio) streams.audio = "loopback";
      // Hide meeting windows before the first captured frame when the entire
      // screen is the source. Window shares leave the room up.
      beginShareSession(from ?? parent?.webContents ?? null, source.kind);
      finish(streams);
    };
    const onCancel = (e: Electron.IpcMainEvent) => {
      if (fromPicker(e)) finish(null);
    };
    const onSettings = (e: Electron.IpcMainEvent) => {
      if (!fromPicker(e)) return;
      void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    };

    ipcMain.on("picker:choose", onChoose);
    ipcMain.on("picker:cancel", onCancel);
    ipcMain.on("picker:open-screen-settings", onSettings);
    win.on("closed", () => finish(null));

    win.webContents.once("did-finish-load", () => {
      const init: PickerInit = {
        sources,
        audioAvailable,
        needsScreenPermission: screenPermissionMissing(),
        platform: process.platform,
      };
      win.webContents.send("picker:init", init);
      win.show();
    });
    void win.loadFile(staticPath("picker.html"));
  });
}

export function installDisplayMediaHandler(ses: Session): void {
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!isSiteOrigin(request.securityOrigin) || !request.videoRequested || pickerOpen) {
      callback(null);
      return;
    }
    const contents = request.frame ? allWebContents.fromFrame(request.frame) : undefined;
    const parent = contents ? BrowserWindow.fromWebContents(contents) : null;

    pickerOpen = true;
    pick(parent, request.audioRequested, contents ?? null)
      .then((streams) => callback(streams))
      .catch((err) => {
        console.error("[screen-picker]", err);
        callback(null);
      })
      .finally(() => {
        pickerOpen = false;
      });
  });
}
