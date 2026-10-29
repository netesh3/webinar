/**
 * Preload for site windows. Runs sandboxed with context isolation, so it can
 * only use the small `electron` surface (contextBridge, ipcRenderer) and must
 * not import other files.
 *
 * On site pages only, it exposes `window.webinarlivDesktop`:
 *
 *   isDesktop: true
 *   platform: "darwin" | "win32" | ...
 *   version: app version
 *   setCallActive(on: boolean)  keep the display awake (explicit override)
 *   setBadgeCount(n: number)    dock / taskbar badge (0 clears)
 *   openSignIn(url: string)     Continue with Google in the system browser
 *                               (web/lib/app-auth.ts; the main process only
 *                               opens the site's own sign-in start URL)
 *   openConnect(url: string)    Connect Zoom / YouTube, or the Drive picker, in
 *                               the system browser (web/lib/app-connect.ts; the
 *                               main process only opens the site's own connect
 *                               start URL with a ticket)
 *
 * The page does not have to call anything: a small main-world script below
 * detects a call by itself (a held screen wake lock, which the live rooms take
 * already, or a live camera / microphone / screen track) and tells the main
 * process, which holds a powerSaveBlocker while any window is in a call.
 */

import { contextBridge, ipcRenderer } from "electron";

function arg(name: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length) ?? "";
}

/** Hosts the main process trusts, passed in through additionalArguments.
 *  Always include webinarliv.com so a missing flag cannot hide the bridge
 *  (without it, Continue with Google runs in this window and Google refuses). */
const siteDomains = [...new Set(["webinarliv.com", ...arg("webinarliv-site-hosts").split(",").filter(Boolean)])];
const appVersion = arg("webinarliv-version");

function isSitePage(): boolean {
  const { protocol, hostname } = window.location;
  if (protocol !== "https:" && protocol !== "http:") return false;
  return siteDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

if (isSitePage()) {
  let explicit = false;
  let detected = false;
  let sent = false;
  const sync = () => {
    const on = explicit || detected;
    if (on === sent) return;
    sent = on;
    ipcRenderer.send("webinarliv:call-active", on);
  };

  contextBridge.exposeInMainWorld("webinarlivDesktop", {
    isDesktop: true,
    platform: process.platform,
    version: appVersion,
    setCallActive(on: unknown) {
      explicit = on === true;
      sync();
    },
    setBadgeCount(count: unknown) {
      const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
      ipcRenderer.send("webinarliv:badge", n);
    },
    openSignIn(url: unknown) {
      if (typeof url !== "string") return Promise.resolve(false);
      return ipcRenderer.invoke("webinarliv:open-sign-in", url);
    },
    openConnect(url: unknown) {
      if (typeof url === "string") ipcRenderer.send("webinarliv:open-connect", url);
    },
    // Used by the main-world helper below; not part of the public surface.
    _detected(on: unknown) {
      detected = on === true;
      sync();
    },
    _focus() {
      ipcRenderer.send("webinarliv:focus");
    },
  });

  contextBridge.executeInMainWorld({ func: installMainWorldHelpers });
}

/**
 * Runs in the page's own world (serialised, so it must be self-contained).
 * Wraps a few browser APIs without changing what they return.
 */
function installMainWorldHelpers(): void {
  type Bridge = { _detected(on: boolean): void; _focus(): void; setBadgeCount(n: number): void };
  const w = window as unknown as Window & { webinarlivDesktop?: Bridge; __webinarlivHelpers?: boolean };
  const bridge = w.webinarlivDesktop;
  if (!bridge || w.__webinarlivHelpers) return;
  w.__webinarlivHelpers = true;

  // --- call detection -----------------------------------------------------
  const locks = new Set<WakeLockSentinel>();
  const tracks = new Set<MediaStreamTrack>();
  let last = false;
  const report = () => {
    for (const t of tracks) if (t.readyState !== "live") tracks.delete(t);
    const on = locks.size > 0 || tracks.size > 0;
    if (on !== last) {
      last = on;
      bridge._detected(on);
    }
  };

  // Screen wake lock: the rooms request one while live (web/lib/wake-lock.ts).
  // Chromium drops the lock while the window is hidden and the page takes a
  // new one when it is visible again, so a lock only stops counting when the
  // page releases it, or a few seconds after the page is visible again.
  const wakeLock = navigator.wakeLock;
  if (wakeLock && typeof wakeLock.request === "function") {
    const request = wakeLock.request.bind(wakeLock);
    wakeLock.request = async (...args: Parameters<WakeLock["request"]>) => {
      const sentinel = await request(...args);
      locks.add(sentinel);
      const release = sentinel.release.bind(sentinel);
      sentinel.release = () => {
        locks.delete(sentinel);
        report();
        return release();
      };
      report();
      return sentinel;
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      setTimeout(() => {
        for (const s of locks) if (s.released) locks.delete(s);
        report();
      }, 5000);
    });
  }

  // Camera, microphone and screen tracks.
  const media = navigator.mediaDevices;
  if (media) {
    for (const name of ["getUserMedia", "getDisplayMedia"] as const) {
      const original = media[name];
      if (typeof original !== "function") continue;
      media[name] = async function (this: MediaDevices, ...args: unknown[]) {
        const stream: MediaStream = await (original as (...a: unknown[]) => Promise<MediaStream>).apply(this, args);
        for (const t of stream.getTracks()) {
          tracks.add(t);
          t.addEventListener("ended", report);
        }
        report();
        return stream;
      } as MediaDevices[typeof name];
    }
  }
  // track.stop() fires no event, so poll as well.
  setInterval(report, 5000);

  // --- badge ----------------------------------------------------------------
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (typeof nav.setAppBadge !== "function") {
    nav.setAppBadge = async (n?: number) => bridge.setBadgeCount(typeof n === "number" ? n : 1);
    nav.clearAppBadge = async () => bridge.setBadgeCount(0);
  }

  // --- notifications: clicking one brings the app forward -------------------
  const Native = window.Notification;
  if (typeof Native === "function") {
    const Wrapped = function (this: unknown, title: string, options?: NotificationOptions) {
      const n = new Native(title, options);
      n.addEventListener("click", () => bridge._focus());
      return n;
    } as unknown as typeof Notification;
    Wrapped.prototype = Native.prototype;
    Object.defineProperty(Wrapped, "permission", { get: () => Native.permission });
    Object.defineProperty(Wrapped, "maxActions", { get: () => (Native as unknown as { maxActions?: number }).maxActions });
    (Wrapped as { requestPermission: typeof Notification.requestPermission }).requestPermission =
      Native.requestPermission.bind(Native);
    (w as unknown as { Notification: typeof Notification }).Notification = Wrapped;
  }
}
