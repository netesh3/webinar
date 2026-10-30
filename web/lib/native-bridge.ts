/* The Webinar Liv mobile app (apps/mobile), as seen from the page.
 *
 * The app is a Capacitor shell whose WebView loads https://webinarliv.com itself, so the
 * native plugins are reached through the bridge Capacitor injects into the page
 * (window.Capacitor.Plugins.*), not through an npm import: nothing here is bundled for
 * ordinary browsers, and in an ordinary browser window.Capacitor is undefined and every
 * function below is a no-op. The component that runs it is components/native-boot.tsx.
 *
 * The decisions (which URL an opened link should load, which pages keep the screen on
 * and ask the native shell for call-class radio/CPU/audio-session) are pure and tested
 * in lib/native-bridge.test.mts.
 */

/** Hosts the app may show. Mirrors capacitor.config.ts server.allowNavigation. */
const SITE = "https://webinarliv.com";

function isOurHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "webinarliv.com" || h.endsWith(".webinarliv.com");
}

/** Where an opened link (App Link, Universal Link, webinarliv:// or a push tap) should
 *  take the WebView, or null to ignore it.
 *
 *   https://webinarliv.com/webinars/x?k=1  -> /webinars/x?k=1   (same origin: a path)
 *   https://www.webinarliv.com/w/x         -> /w/x
 *   https://recordings.webinarliv.com/a    -> that URL as is    (an allowed subdomain)
 *   webinarliv://webinars/x                -> /webinars/x       (custom scheme fallback)
 *   webinarliv:///webinars/x               -> /webinars/x
 *   webinarliv://auth/complete?code=c      -> /auth/complete?code=c  (the Google hand-off)
 *   /webinars/x                            -> /webinars/x       (a path, as a push may carry)
 *   anything else                          -> null
 */
export function routeForOpenedUrl(raw: string): string | null {
  // A bare site path (an older push payload's data.url): as is, but never "//host".
  if (raw.startsWith("/") && !raw.startsWith("//") && !raw.includes("\\")) return raw;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "webinarliv:") {
    // webinarliv://webinars/x parses with "webinars" as the host; put it back in the path.
    const path = `${u.host ? `/${u.host}` : ""}${u.pathname}`.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    return `${path || "/"}${u.search}${u.hash}`;
  }
  if (u.protocol !== "https:" || !isOurHost(u.hostname)) return null;
  const h = u.hostname.toLowerCase();
  if (h === "webinarliv.com" || h === "www.webinarliv.com") {
    return `${u.pathname}${u.search}${u.hash}`;
  }
  return u.toString();
}

/** What an opened route means for a system-browser hand-off (29 Oct 2026):
 *   "navigate"  the end of a sign-in or a connect (/auth/complete, /connect/complete): close
 *               the browser sheet and load the page, which finishes it
 *   "stay"      a Drive pick handed over (/connect/picked): close the sheet, load nothing,
 *               because the live room that asked is collecting it
 *   "none"      any other link */
export function handOffReturn(route: string): "navigate" | "stay" | "none" {
  const path = (route.split(/[?#]/)[0] ?? "").replace(/\/+$/, "") || "/";
  if (path === "/auth/complete" || path === "/connect/complete") return "navigate";
  if (path === "/connect/picked") return "stay";
  return "none";
}

/** A live session: the screen stays on while one of these is open. */
export function keepsScreenAwake(pathname: string): boolean {
  return /^\/(webinars|host)\/[^/]+\/(room|recording)(\/|$)/.test(pathname) ||
    /^\/w\/[^/]+\/recording(\/|$)/.test(pathname);
}

// ------------------------------------------------------------------ runtime

type Listener = { remove: () => Promise<void> | void };
type Plugin = Record<string, (...args: never[]) => Promise<unknown>> & {
  addListener?: (event: string, fn: (data: never) => void) => Promise<Listener>;
};
type CapacitorGlobal = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, Plugin | undefined>;
};

function cap(): CapacitorGlobal | null {
  if (typeof window === "undefined") return null;
  const c = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
  return c?.isNativePlatform?.() ? c : null;
}

/** True inside the Android / iOS app. */
export function isNativeApp(): boolean {
  return cap() !== null;
}

function plugin(name: string): Plugin | null {
  const c = cap();
  if (!c) return null;
  if (c.isPluginAvailable && !c.isPluginAvailable(name)) return null;
  return c.Plugins?.[name] ?? null;
}

// The plugins' own signatures, narrowed to what is used here.
type AppPlugin = {
  getLaunchUrl: () => Promise<{ url?: string } | undefined>;
  addListener: (event: "appUrlOpen", fn: (e: { url: string }) => void) => Promise<Listener>;
};
type SharePlugin = {
  share: (o: { title?: string; text?: string; url?: string; dialogTitle?: string }) => Promise<unknown>;
};
/* @capacitor-firebase/messaging (29 Oct 2026): an FCM registration token on iOS as well as
 * Android, so the API sends to both through FCM (api/internal/push/fcm.go). */
type MessagingPlugin = {
  checkPermissions: () => Promise<{ receive: string }>;
  requestPermissions: () => Promise<{ receive: string }>;
  getToken: () => Promise<{ token: string }>;
  addListener: (event: string, fn: (data: never) => void) => Promise<Listener>;
};
type BrowserPlugin = { close: () => Promise<void> };
type KeepAwakePlugin = { keepAwake: () => Promise<void>; allowSleep: () => Promise<void> };
type CallQosPlugin = { setActive: (o: { on: boolean }) => Promise<void> };

const LAUNCH_KEY = "webinarliv.native.launchUrl";
const LAST_OPEN_KEY = "webinarliv.native.lastOpen";

function open(raw: string): void {
  const route = routeForOpenedUrl(raw);
  if (!route) return;
  const hand = handOffReturn(route);
  if (hand !== "none") {
    /* A system-browser hand-off is back (lib/app-auth.ts, lib/app-connect.ts): put away the
     * in-app browser sheet it ran in. iOS only; Android's Custom Tab closes as the app comes
     * forward. */
    const browser = plugin("Browser") as unknown as BrowserPlugin | null;
    if (browser && cap()?.getPlatform?.() === "ios") void browser.close().catch(() => {});
  }
  // A Drive pick: the room that asked for it is open and collects it itself. Stay put.
  if (hand === "stay") return;
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (route === here || route === window.location.href) return;
  /* A cold start can report the same link twice: getLaunchUrl, and the appUrlOpen event
   * Capacitor retains until a listener exists. One navigation per link per few seconds. */
  const now = Date.now();
  try {
    const last = JSON.parse(sessionStorage.getItem(LAST_OPEN_KEY) ?? "null") as
      | { route: string; at: number }
      | null;
    if (last && last.route === route && now - last.at < 5_000) return;
    sessionStorage.setItem(LAST_OPEN_KEY, JSON.stringify({ route, at: now }));
  } catch {
    // Storage unavailable: navigate anyway.
  }
  window.location.assign(route.startsWith("/") ? `${SITE}${route}` : route);
}

/** App Links / Universal Links / webinarliv://: load the tapped link in the WebView.
 *  Cold start reads the launch URL once per app session (the WebView first loads the
 *  home page; this then moves to the link). Warm, appUrlOpen fires. */
async function wireDeepLinks(): Promise<Listener | null> {
  const app = plugin("App") as unknown as AppPlugin | null;
  if (!app) return null;
  try {
    const launch = await app.getLaunchUrl();
    if (launch?.url && sessionStorage.getItem(LAUNCH_KEY) !== launch.url) {
      sessionStorage.setItem(LAUNCH_KEY, launch.url);
      open(launch.url);
    }
  } catch {
    // No launch URL: an ordinary start from the icon.
  }
  return app.addListener("appUrlOpen", (e) => open(e.url));
}

/** The native share sheet behind navigator.share, so the site's existing Share buttons
 *  (invite panel, attendee link) work in the Android WebView, which has no Web Share
 *  API. WKWebView already has one that opens the iOS sheet; it is left alone. */
function wireShare(): void {
  const share = plugin("Share") as unknown as SharePlugin | null;
  if (!share || typeof navigator.share === "function") return;
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: (data: ShareData = {}) =>
      share.share({ title: data.title, text: data.text, url: data.url, dialogTitle: data.title })
        .then(() => undefined),
  });
}

const PUSH_ASKED_KEY = "webinarliv.native.pushAsked";
/** The install's FCM token, once Firebase has given one. */
const PUSH_TOKEN_KEY = "webinarliv.native.pushToken";
/** What the API last accepted: {token, user, at}. */
const PUSH_SYNCED_KEY = "webinarliv.native.pushSynced";
/** Re-send a token the API already has once a day, so a lost row heals by itself. */
const PUSH_RESYNC_MS = 24 * 60 * 60_000;

/** Whether the API needs (token, user) again. Pure, for the test. */
export function pushNeedsSync(
  last: { token?: string; user?: string; at?: number } | null,
  token: string,
  user: string,
  now: number,
): boolean {
  if (!token || !user) return false;
  if (!last || last.token !== token || last.user !== user) return true;
  return !last.at || now - last.at > PUSH_RESYNC_MS;
}

let signedInUser: string | null = null;
let syncing: Promise<void> | null = null;

function readJSON<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
  } catch {
    return null;
  }
}

async function appVersion(): Promise<string> {
  const app = plugin("App") as unknown as { getInfo?: () => Promise<{ version?: string; build?: string }> } | null;
  try {
    const info = await app?.getInfo?.();
    return info?.version ? `${info.version}${info.build ? ` (${info.build})` : ""}` : "";
  } catch {
    return "";
  }
}

/** Hands the install's token to the API for the signed-in account (POST /api/push/native). */
async function syncPushToken(): Promise<void> {
  const user = signedInUser;
  const token = localStorage.getItem(PUSH_TOKEN_KEY) ?? "";
  const platform = cap()?.getPlatform?.();
  if (!user || !token || (platform !== "ios" && platform !== "android")) return;
  if (!pushNeedsSync(readJSON(PUSH_SYNCED_KEY), token, user, Date.now())) return;
  try {
    const res = await fetch("/api/push/native", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, token, appVersion: await appVersion() }),
    });
    if (res.ok) {
      localStorage.setItem(PUSH_SYNCED_KEY, JSON.stringify({ token, user, at: Date.now() }));
    }
  } catch {
    // Offline: the next page load tries again.
  }
}

function syncSoon(): void {
  syncing = (syncing ?? Promise.resolve()).then(syncPushToken, syncPushToken);
}

/** Who is signed in, from the session (components/native-boot.tsx NativeSessionSync). A
 *  signed-in account gets this install's token; null is signed out. No-op outside the app. */
export function setNativeSessionUser(userID: string | null): void {
  if (!isNativeApp()) return;
  signedInUser = userID;
  if (userID) syncSoon();
}

/** Before signing out: this install stops hearing from the account (DELETE /api/push/native,
 *  which needs the session that is about to end). No-op outside the app or without a token. */
export async function unregisterNativePush(): Promise<void> {
  if (!isNativeApp()) return;
  const token = localStorage.getItem(PUSH_TOKEN_KEY) ?? "";
  localStorage.removeItem(PUSH_SYNCED_KEY);
  signedInUser = null;
  if (!token) return;
  try {
    await fetch("/api/push/native", {
      method: "DELETE",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
  } catch {
    // Signed out anyway; the token moves to whoever signs in next on this install.
  }
}

function keepToken(token: string | undefined): void {
  if (!token) return;
  localStorage.setItem(PUSH_TOKEN_KEY, token);
  syncSoon();
}

/** Native push through Firebase Cloud Messaging: asks once, gets the install's FCM token,
 *  and sends it to the API for the signed-in account (and again whenever Firebase rotates
 *  it). A tapped notification opens its data.url. */
async function wirePush(): Promise<Listener[]> {
  const push = plugin("FirebaseMessaging") as unknown as MessagingPlugin | null;
  if (!push) return [];
  const platform = cap()?.getPlatform?.() ?? "native";
  const listeners = await Promise.all([
    push.addListener("tokenReceived", (t: { token: string }) => keepToken(t.token)),
    // A tapped notification whose payload carries data.url opens that page.
    push.addListener(
      "notificationActionPerformed",
      (a: { notification?: { data?: { url?: string } } }) => {
        const url = a.notification?.data?.url;
        if (url) open(url);
      },
    ),
  ]);
  try {
    /* Android: only with Firebase in the build. Without google-services.json Firebase is
     * not initialised and asking it for a token throws on the main thread, so the app's
     * own WebinarLivApp plugin (AppInfoPlugin.java) is asked first. Missing plugin means an
     * unknown build: leave push off. iOS without GoogleService-Info.plist rejects getToken. */
    if (platform === "android") {
      const info = plugin("WebinarLivApp") as unknown as
        | { info: () => Promise<{ pushConfigured?: boolean }> }
        | null;
      const configured = info ? (await info.info()).pushConfigured === true : false;
      if (!configured) {
        console.info("[webinarliv-app] push off: this build has no google-services.json");
        return listeners;
      }
    }
    let { receive } = await push.checkPermissions();
    if (receive.startsWith("prompt") && !localStorage.getItem(PUSH_ASKED_KEY)) {
      localStorage.setItem(PUSH_ASKED_KEY, "1");
      ({ receive } = await push.requestPermissions());
    }
    if (receive === "granted") keepToken((await push.getToken()).token);
  } catch (err) {
    // A build without the Firebase config files lands here: push is simply off.
    console.warn("[webinarliv-app] push unavailable:", err);
  }
  return listeners;
}

/** Wire everything once per page load. Returns the teardown. */
export function startNativeBridge(): () => void {
  if (!isNativeApp()) return () => {};
  document.documentElement.dataset.nativeApp = cap()?.getPlatform?.() ?? "native";
  wireShare();
  const pending: Promise<Listener | Listener[] | null>[] = [wireDeepLinks(), wirePush()];
  return () => {
    for (const p of pending) {
      void p.then((l) => {
        for (const one of Array.isArray(l) ? l : l ? [l] : []) void one.remove();
      }).catch(() => {});
    }
  };
}

/** Keep the screen on (or let it sleep) for the page at `pathname`, and ask
 *  the native shell for call-class resources (Android foreground service +
 *  Wi-Fi/CPU locks, iOS videoChat audio session). No-op in a browser, and
 *  no-op in an older app build that has no CallQos plugin — the site still
 *  loads. */
export function syncKeepAwake(pathname: string): void {
  const on = keepsScreenAwake(pathname);
  const k = plugin("KeepAwake") as unknown as KeepAwakePlugin | null;
  if (k) void (on ? k.keepAwake() : k.allowSleep()).catch(() => {});
  const qos = plugin("CallQos") as unknown as CallQosPlugin | null;
  if (qos) void qos.setActive({ on }).catch(() => {});
}
