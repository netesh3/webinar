/* The Webinar Liv mobile app (apps/mobile), as seen from the page.
 *
 * The app is a Capacitor shell whose WebView loads https://webinarliv.com itself, so the
 * native plugins are reached through the bridge Capacitor injects into the page
 * (window.Capacitor.Plugins.*), not through an npm import: nothing here is bundled for
 * ordinary browsers, and in an ordinary browser window.Capacitor is undefined and every
 * function below is a no-op. The component that runs it is components/native-boot.tsx.
 *
 * The decisions (which URL an opened link should load, which pages keep the screen on)
 * are pure and tested in lib/native-bridge.test.mts.
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
 *   anything else                          -> null
 */
export function routeForOpenedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === "webinarliv:") {
    // webinarliv://webinars/x parses with "webinars" as the host; put it back in the path.
    const path = `${u.host ? `/${u.host}` : ""}${u.pathname}`.replace(/\/{2,}/g, "/");
    return `${path || "/"}${u.search}${u.hash}`;
  }
  if (u.protocol !== "https:" || !isOurHost(u.hostname)) return null;
  const h = u.hostname.toLowerCase();
  if (h === "webinarliv.com" || h === "www.webinarliv.com") {
    return `${u.pathname}${u.search}${u.hash}`;
  }
  return u.toString();
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
type PushPlugin = {
  checkPermissions: () => Promise<{ receive: string }>;
  requestPermissions: () => Promise<{ receive: string }>;
  register: () => Promise<void>;
  addListener: (event: string, fn: (data: never) => void) => Promise<Listener>;
};
type KeepAwakePlugin = { keepAwake: () => Promise<void>; allowSleep: () => Promise<void> };

const LAUNCH_KEY = "webinarliv.native.launchUrl";
const LAST_OPEN_KEY = "webinarliv.native.lastOpen";

function open(raw: string): void {
  const route = routeForOpenedUrl(raw);
  if (!route) return;
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

/** Native push (FCM / APNs). Registers and logs the device token.
 *
 * FOLLOW-UP: the API only knows Web Push subscriptions (api/internal/api/push.go,
 * VAPID); there is no endpoint that accepts an FCM / APNs token yet, so the token is
 * logged and not sent anywhere. See apps/mobile/README.md, "Push notifications". */
async function wirePush(): Promise<Listener[]> {
  const push = plugin("PushNotifications") as unknown as PushPlugin | null;
  if (!push) return [];
  const platform = cap()?.getPlatform?.() ?? "native";
  const listeners = await Promise.all([
    push.addListener("registration", (t: { value: string }) => {
      console.info(`[webinarliv-app] ${platform} push token:`, t.value);
    }),
    push.addListener("registrationError", (e: { error: unknown }) => {
      console.warn("[webinarliv-app] push registration failed:", e.error);
    }),
    // A tapped notification whose payload carries data.url opens that page.
    push.addListener(
      "pushNotificationActionPerformed",
      (a: { notification?: { data?: { url?: string } } }) => {
        const url = a.notification?.data?.url;
        if (url) open(url);
      },
    ),
  ]);
  try {
    /* Android: only with Firebase in the build. Without google-services.json the
     * plugin's register() throws on the main thread and the app crashes, so the app's
     * own WebinarLivApp plugin (AppInfoPlugin.java) is asked first. Missing plugin
     * means an unknown build: leave push off. iOS just reports registrationError. */
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
    if (receive === "granted") await push.register();
  } catch (err) {
    // Android without google-services.json lands here: push is simply off.
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

/** Keep the screen on (or let it sleep) for the page at `pathname`. */
export function syncKeepAwake(pathname: string): void {
  const k = plugin("KeepAwake") as unknown as KeepAwakePlugin | null;
  if (!k) return;
  void (keepsScreenAwake(pathname) ? k.keepAwake() : k.allowSleep()).catch(() => {});
}
