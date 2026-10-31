/**
 * Webinar Liv desktop: a secure Electron shell around the live site.
 *
 * See README.md for how navigation, sign-in, screen sharing, deep links and
 * updates work.
 */

import { app, BrowserWindow, ipcMain, session, shell, type BrowserWindowConstructorOptions } from "electron";
import path from "node:path";
import {
  findLaunchTarget,
  isAuthCompleteUrl,
  isConnectCompleteUrl,
  isConnectStartUrl,
  isFocusOnlyLink,
  isSignInStartUrl,
  isSiteUrl,
  PROTOCOL,
  resolveLaunchTarget,
  START_URL,
} from "./config";
import { buildMenu } from "./menu";
import { isCallActive, registerPowerIpc } from "./power";
import { applyChromiumQosFlags } from "./qos";
import { installDisplayMediaHandler } from "./screen-picker";
import { guardContents, hardenApp, installPermissionHandlers, senderUrl } from "./security";
import { focusShareBar, isShareSessionActive, registerShareIpc } from "./share-session";
import { startAutoUpdates } from "./updater";
import { loadWindowState, trackWindowState } from "./window-state";

app.setName("Webinar Liv");
if (process.platform === "win32") app.setAppUserModelId("com.webinarliv.desktop");

/* LiveKit encode / decode / adaptiveStream need a full time slice even when the
 * window is unfocused, occluded by the share picker, or on a dual-GPU laptop.
 * See qos.ts for what each switch does. Must run before app.whenReady().
 * Hardware acceleration stays on (never disableHardwareAcceleration). */
applyChromiumQosFlags(app.commandLine);

/*
 * The user agent is Electron's own, plus a WebinarLivDesktop/<version> marker
 * (29 Oct 2026). The app used to strip the Electron/x and app-name tokens so
 * that Google would take it for plain Chrome and allow sign-in in the window.
 * It no longer pretends: Continue with Google opens in the system browser and
 * comes back through webinarliv:// (openSignIn below, web/lib/app-auth.ts).
 * The marker is not WebinarLivApp/, which is the phone app's and hides
 * purchases on iOS (web/lib/device.ts); the desktop app keeps them.
 */
app.userAgentFallback = `${app.userAgentFallback} WebinarLivDesktop/${app.getVersion()}`;

// Single instance: a second launch (deep link, file association, taskbar)
// hands its arguments to the running app and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Register webinarliv:// (the installers also register it; this covers
// `npm start` and a moved app). macOS only accepts this after `ready`.
function registerProtocol(): void {
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }
}
if (process.platform !== "darwin") registerProtocol();

let mainWindow: BrowserWindow | null = null;
/** A deep link that arrived before the window existed (macOS open-url at launch). */
let pendingTarget: string | null = findLaunchTarget(process.argv);

const siteHosts = [...new Set(["webinarliv.com", START_URL.hostname])].join(",");

function webPreferences(): BrowserWindowConstructorOptions["webPreferences"] {
  return {
    preload: path.join(__dirname, "preload.js"),
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: true,
    // Always off, not only in a live room: Chromium otherwise throttles rAF /
    // WebRTC in an unfocused or occluded window, which is exactly when a host
    // is looking at slides or the share picker. qos.ts covers process flags.
    backgroundThrottling: false,
    additionalArguments: [`--webinarliv-site-hosts=${siteHosts}`, `--webinarliv-version=${app.getVersion()}`],
  };
}

function childWindowOptions(): BrowserWindowConstructorOptions {
  return {
    width: 1100,
    height: 760,
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  };
}

function offlinePage(win: BrowserWindow, failedUrl: string): void {
  void win.loadFile(path.join(__dirname, "..", "static", "offline.html"), {
    query: { url: isSiteUrl(failedUrl) ? failedUrl : START_URL.toString() },
  });
}

function createMainWindow(target?: string | null): BrowserWindow {
  const state = loadWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 480,
    minHeight: 400,
    show: false,
    title: "Webinar Liv",
    backgroundColor: "#ffffff",
    autoHideMenuBar: false,
    webPreferences: webPreferences(),
  });
  if (state.maximized) win.maximize();
  trackWindowState(win);

  guardContents(win.webContents, childWindowOptions);
  win.once("ready-to-show", () => win.show());
  // Show even if the first paint never comes (slow network), so the app never looks dead.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 4000);

  win.webContents.on("did-fail-load", (_e, code, _desc, url, isMainFrame) => {
    // -3 is ERR_ABORTED: a navigation replaced by another, not a failure.
    if (isMainFrame && code !== -3 && isSiteUrl(url)) offlinePage(win, url);
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  void win.loadURL(target ?? START_URL.toString());
  return win;
}

/** Opens a site URL from a deep link / argument. */
function openTarget(target: string): void {
  if (!app.isReady()) {
    pendingTarget = target;
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow(target);
    return;
  }
  if (isCallActive()) {
    // Don't pull someone out of a live call: open the link alongside it.
    const win = new BrowserWindow({ ...childWindowOptions(), title: "Webinar Liv" });
    guardContents(win.webContents, childWindowOptions);
    void win.loadURL(target);
    win.focus();
    return;
  }
  void mainWindow.loadURL(target);
  focusMain();
}

function focusMain(): void {
  if (isShareSessionActive()) {
    focusShareBar();
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// macOS delivers webinarliv:// links here, possibly before "ready".
app.on("open-url", (event, url) => {
  event.preventDefault();
  const target = resolveLaunchTarget(url);
  if (target) openTarget(target);
  else focusMain();
  /* Back from the system browser (a Google sign-in, a connect, a Drive pick): the browser is
   * in front, so take focus. */
  const handOff = (target !== null && (isAuthCompleteUrl(target) || isConnectCompleteUrl(target))) ||
    isFocusOnlyLink(url);
  if (handOff && app.isReady()) app.focus({ steal: true });
});

// Windows / Linux deliver links (and https URLs) as arguments of a second launch.
app.on("second-instance", (_event, argv) => {
  const target = findLaunchTarget(argv);
  if (target) openTarget(target);
  else focusMain();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (isShareSessionActive()) {
    focusShareBar();
    return;
  }
  if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  else focusMain();
});

hardenApp();

app.whenReady().then(() => {
  const ses = session.defaultSession;
  installPermissionHandlers(ses);
  installDisplayMediaHandler(ses);
  registerPowerIpc();
  registerShareIpc(() => mainWindow);

  registerProtocol();

  ipcMain.on("webinarliv:badge", (event, count: unknown) => {
    if (!isSiteUrl(senderUrl(event))) return;
    const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    app.setBadgeCount(n);
  });
  /* Continue with Google: the site's own start URL, in the system browser, which Google
   * allows and an embedded window it does not. Only that one URL, only from a site page.
   * invoke (not send) so the page knows if the browser actually opened. */
  ipcMain.handle("webinarliv:open-sign-in", async (event, url: unknown) => {
    if (!isSiteUrl(senderUrl(event))) return false;
    if (typeof url !== "string" || !isSignInStartUrl(url)) {
      console.warn("[auth] refusing to open sign-in URL");
      return false;
    }
    try {
      await shell.openExternal(url);
      return true;
    } catch {
      console.warn("[auth] system browser did not open");
      return false;
    }
  });
  /* Connect Zoom / YouTube and the Drive picker (web/lib/app-connect.ts, 29 Oct 2026): the
   * site's own connect start route with a one-time ticket, in the system browser. Only that,
   * only from a site page. */
  ipcMain.on("webinarliv:open-connect", (event, url: unknown) => {
    if (!isSiteUrl(senderUrl(event))) return;
    if (typeof url !== "string" || !isConnectStartUrl(url)) {
      console.warn("[connect] refusing to open a connect URL");
      return;
    }
    void shell.openExternal(url);
  });
  /* An incoming call is ringing in this window (web/components/incoming-call.tsx, 31 Oct 2026):
   * flash it and bounce the dock until the ring stops. Attention only, never focus: a call
   * must not pull somebody's typing into another window. */
  let dockBounce: number | null = null;
  ipcMain.on("webinarliv:ring-attention", (event, on: unknown) => {
    if (!isSiteUrl(senderUrl(event))) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (on === true) {
      if (win && !win.isFocused()) win.flashFrame(true);
      if (process.platform === "darwin" && app.dock && dockBounce === null) dockBounce = app.dock.bounce("critical");
      return;
    }
    win?.flashFrame(false);
    if (dockBounce !== null && app.dock) app.dock.cancelBounce(dockBounce);
    dockBounce = null;
  });
  ipcMain.on("webinarliv:focus", (event) => {
    if (!isSiteUrl(senderUrl(event))) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  buildMenu(() => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    void win?.loadURL(START_URL.toString());
  });

  mainWindow = createMainWindow(pendingTarget);
  pendingTarget = null;

  startAutoUpdates();
});
