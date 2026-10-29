/** Native application menu. */

import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from "electron";
import { START_URL } from "./config";
import { openExternal } from "./security";
import { checkForUpdatesInteractive } from "./updater";

function focused(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

function showAbout(): void {
  if (process.platform === "darwin") {
    app.showAboutPanel();
    return;
  }
  const win = focused();
  const opts = {
    type: "info" as const,
    title: "About Webinar Liv",
    message: `Webinar Liv ${app.getVersion()}`,
    detail: `Electron ${process.versions.electron}\nChromium ${process.versions.chrome}\n\n${START_URL.origin}`,
  };
  void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
}

export function buildMenu(goHome: () => void): void {
  const isMac = process.platform === "darwin";

  app.setAboutPanelOptions({
    applicationName: "Webinar Liv",
    applicationVersion: app.getVersion(),
    copyright: "© Webinar Liv",
    website: "https://webinarliv.com",
  });

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { label: "About Webinar Liv", click: showAbout },
              { label: "Check for Updates…", click: () => void checkForUpdatesInteractive() },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: goHome },
        {
          label: "Open in Browser",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            const url = focused()?.webContents.getURL();
            if (url) openExternal(url);
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        {
          label: "Back",
          accelerator: isMac ? "Cmd+[" : "Alt+Left",
          click: () => focused()?.webContents.navigationHistory.goBack(),
        },
        {
          label: "Forward",
          accelerator: isMac ? "Cmd+]" : "Alt+Right",
          click: () => focused()?.webContents.navigationHistory.goForward(),
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Webinar Liv Help", click: () => openExternal("https://webinarliv.com/contact") },
        ...(isMac
          ? []
          : ([
              { type: "separator" },
              { label: "Check for Updates…", click: () => void checkForUpdatesInteractive() },
              { label: "About Webinar Liv", click: showAbout },
            ] as MenuItemConstructorOptions[])),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
