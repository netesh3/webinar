/**
 * What site windows may do: which permissions they get, where they may
 * navigate, and which popups open inside the app.
 */

import {
  app,
  shell,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import { isExternalSafe, isFlowUrl, isSiteOrigin, isSiteUrl, PROTOCOL, resolveLaunchTarget } from "./config";

/**
 * Granted to the site origin only. Everything else (geolocation, MIDI, HID,
 * USB, serial, ...) is refused, and nothing is granted to other origins,
 * including third-party iframes on site pages.
 *
 *  - media, display-capture: camera, microphone, screen share
 *  - notifications
 *  - clipboard-read, clipboard-sanitized-write: copy invite links, paste
 *  - fullscreen: the video player's full-screen button
 *  - screen-wake-lock: the live rooms keep the screen on (web/lib/wake-lock.ts)
 */
const ALLOWED_PERMISSIONS = new Set([
  "media",
  "display-capture",
  "notifications",
  "clipboard-read",
  "clipboard-sanitized-write",
  "fullscreen",
  "screen-wake-lock",
]);

function originOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** macOS asks once per app for camera / microphone; the OS prompt must come first. */
async function ensureMacMediaAccess(mediaTypes: readonly string[] | undefined): Promise<boolean> {
  if (process.platform !== "darwin") return true;
  const wanted = mediaTypes && mediaTypes.length > 0 ? mediaTypes : ["audio", "video"];
  for (const type of wanted) {
    const device = type === "video" ? "camera" : type === "audio" ? "microphone" : null;
    if (!device) continue;
    if (systemPreferences.getMediaAccessStatus(device) === "granted") continue;
    if (!(await systemPreferences.askForMediaAccess(device))) return false;
  }
  return true;
}

export function installPermissionHandlers(ses: Session): void {
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const origin = originOf(details.requestingUrl);
    if (!ALLOWED_PERMISSIONS.has(permission) || !isSiteOrigin(origin)) {
      callback(false);
      return;
    }
    if (permission === "media") {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
      ensureMacMediaAccess(mediaTypes)
        .then(callback)
        .catch(() => callback(false));
      return;
    }
    callback(true);
  });

  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    return ALLOWED_PERMISSIONS.has(permission) && isSiteOrigin(requestingOrigin);
  });

  // No WebUSB / HID / serial devices for anyone.
  ses.setDevicePermissionHandler(() => false);
}

export function openExternal(url: string): void {
  if (isExternalSafe(url)) void shell.openExternal(url);
  else console.warn("[security] refusing to open", url);
}

/** URL of the frame that sent an IPC message. senderFrame.url can throw once
 *  the frame is gone; fall back to the webContents URL so a sign-in click is
 *  not silently dropped. */
export function senderUrl(event: {
  senderFrame?: { url: string } | null;
  sender: { getURL: () => string };
}): string {
  try {
    const fromFrame = event.senderFrame?.url;
    if (fromFrame) return fromFrame;
  } catch {
    // Render frame was disposed.
  }
  try {
    return event.sender.getURL();
  } catch {
    return "";
  }
}

function appProtocolTarget(url: string): string | null | undefined {
  if (!url.startsWith(`${PROTOCOL}:`)) return undefined;
  return resolveLaunchTarget(url);
}

/** WebContents opened as an in-app popup for a sign-in / payment flow. */
const flowContents = new WeakSet<WebContents>();

/**
 * Applies the navigation rules to every WebContents the app creates:
 *
 *  - Site windows stay on the site (webinarliv.com, its subdomains such as
 *    recordings.webinarliv.com, and the configured start host) plus the hosts
 *    a sign-in / payment flow passes through (config.ts FLOW_DOMAINS). Any
 *    other link opens in the system browser.
 *  - Flow popups (Razorpay 3-D Secure, an about:blank popup the page fills or
 *    points somewhere) may move between https pages freely, since a bank's
 *    page can be on any host; they never get the bridge (see preload.ts).
 *  - window.open of a site URL opens another app window (rooms open in their
 *    own window, as they open in a new tab on the web).
 */
export function guardContents(
  contents: WebContents,
  childWindowOptions: () => BrowserWindowConstructorOptions,
): void {
  contents.on("will-navigate", (event, url) => {
    const appTarget = appProtocolTarget(url);
    if (appTarget !== undefined) {
      event.preventDefault();
      if (appTarget) void contents.loadURL(appTarget);
      return;
    }
    if (isSiteUrl(url) || isFlowUrl(url)) return;
    if (flowContents.has(contents) && url.startsWith("https:")) return;
    event.preventDefault();
    openExternal(url);
  });

  contents.on("will-redirect", (event, url) => {
    const appTarget = appProtocolTarget(url);
    if (appTarget !== undefined) {
      event.preventDefault();
      if (appTarget) void contents.loadURL(appTarget);
      return;
    }
    if (isSiteUrl(url) || isFlowUrl(url)) return;
    if (flowContents.has(contents) && url.startsWith("https:")) return;
    event.preventDefault();
    openExternal(url);
  });

  contents.on("will-attach-webview", (event) => event.preventDefault());

  contents.setWindowOpenHandler(({ url }) => {
    const blank = url === "" || url === "about:blank";
    if (blank || isSiteUrl(url) || isFlowUrl(url)) {
      return { action: "allow", overrideBrowserWindowOptions: childWindowOptions() };
    }
    openExternal(url);
    return { action: "deny" };
  });

  contents.on("did-create-window", (child, { url }) => {
    if (!isSiteUrl(url)) flowContents.add(child.webContents);
    guardContents(child.webContents, childWindowOptions);
  });
}

/** Blocks anything that is not a window we made (e.g. <webview>, devtools extensions). */
export function hardenApp(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}
