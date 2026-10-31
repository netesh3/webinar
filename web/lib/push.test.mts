/* Web Push and install decisions (lib/push.ts).
 *
 * Run: node --experimental-strip-types --no-warnings lib/push.test.mts
 */

import {
  dismissKey,
  iosVersion,
  notifyCardState,
  optInKey,
  optInState,
  pushHost,
  pushSupport,
  subscribeBody,
  unblockHint,
  urlBase64ToUint8Array,
  type PushEnv,
  type PushHost,
} from "./push.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
  }
}

const IPHONE_17 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_16_3 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.3 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const MAC_SAFARI = IPAD_DESKTOP; // same string; no touch points makes it a Mac

const full = (ua: string, extra: Partial<PushEnv> = {}): PushEnv => ({
  ua,
  serviceWorker: true,
  pushManager: true,
  notification: true,
  standalone: false,
  ...extra,
});

// ---- iOS version
ok("iPhone 17.5", iosVersion(IPHONE_17) === 17.5, String(iosVersion(IPHONE_17)));
ok("iPhone 16.3", iosVersion(IPHONE_16_3) === 16.3);
ok("iPad as Mac with touch", iosVersion(IPAD_DESKTOP, 5) === 17.4, String(iosVersion(IPAD_DESKTOP, 5)));
ok("a Mac is not iOS", iosVersion(MAC_SAFARI, 0) === null);
ok("Android is not iOS", iosVersion(ANDROID_CHROME) === null);

// ---- support
ok("Android Chrome supported", pushSupport(full(ANDROID_CHROME)) === "supported");
ok("desktop without PushManager unsupported", pushSupport(full(MAC_SAFARI, { pushManager: false })) === "unsupported");
ok(
  "iPhone in Safari must install first",
  pushSupport(full(IPHONE_17, { pushManager: false, notification: false })) === "ios-install",
);
ok("iPhone installed is supported", pushSupport(full(IPHONE_17, { standalone: true })) === "supported");
ok("iOS 16.3 has no web push at all", pushSupport(full(IPHONE_16_3)) === "unsupported");
ok(
  "iPad (desktop UA) in Safari must install",
  pushSupport(full(IPAD_DESKTOP, { maxTouchPoints: 5, pushManager: false })) === "ios-install",
);
ok("no service worker, nothing", pushSupport(full(ANDROID_CHROME, { serviceWorker: false })) === "unsupported");

// ---- opt-in state
const base = { serverEnabled: true, support: "supported" as const, permission: "default" as NotificationPermission, subscribed: false };
ok("server off hides", optInState({ ...base, serverEnabled: false }) === "hidden");
ok("unsupported hides", optInState({ ...base, support: "unsupported" }) === "hidden");
ok("ios-install says install", optInState({ ...base, support: "ios-install" }) === "install");
ok("not asked yet asks", optInState(base) === "ask");
ok("busy while subscribing", optInState({ ...base, busy: true }) === "busy");
ok("denied is blocked", optInState({ ...base, permission: "denied" }) === "blocked");
ok("granted and subscribed is on", optInState({ ...base, permission: "granted", subscribed: true }) === "on");
ok("granted but not subscribed still asks", optInState({ ...base, permission: "granted" }) === "ask");

// ---- encoding and bodies
const key = urlBase64ToUint8Array("BAEC_-8");
ok("base64url decodes with - and _", key.length === 5 && key[0] === 4 && key[3] === 0xff && key[4] === 0xef, Array.from(key).join(","));
ok(
  "subscribe body",
  JSON.stringify(subscribeBody({ endpoint: "https://e", keys: { p256dh: "p", auth: "a" } }, "UA", "KEY-1")) ===
    JSON.stringify({ endpoint: "https://e", keys: { p256dh: "p", auth: "a" }, ua: "UA", joinKey: "KEY-1" }),
);
ok("no joinKey field for an account", !("joinKey" in (subscribeBody({ endpoint: "https://e", keys: { p256dh: "p", auth: "a" } }, "UA") ?? {})));
ok("incomplete subscription is null", subscribeBody({ endpoint: "https://e", keys: { p256dh: "p" } }, "UA") === null);
ok("opt-in key", optInKey("ABC") === "webcast.push.reg.ABC");
ok("dismiss key is per session", dismissKey("abc-123") === "webcast.push.dismissed.abc-123");

// ---- where the page runs (31 Oct 2026)
ok("a browser tab", pushHost({ nativeAppUA: false, desktopBridge: false }) === "browser");
ok("the phone app", pushHost({ nativeAppUA: true, desktopBridge: false }) === "phone-app");
ok("the desktop bridge wins", pushHost({ nativeAppUA: true, desktopBridge: true }) === "desktop-app");

// ---- the notify card after registering / in the lobby
const card = {
  ...base,
  host: "browser" as PushHost,
  signedIn: false,
  dismissed: false,
};
ok("browser, not asked: the button", notifyCardState(card) === "ask");
ok("busy while subscribing", notifyCardState({ ...card, busy: true }) === "busy");
ok("on", notifyCardState({ ...card, permission: "granted", subscribed: true }) === "on");
ok("blocked says how to undo", notifyCardState({ ...card, permission: "denied" }) === "blocked");
ok("iOS Safari tab: get the app", notifyCardState({ ...card, support: "ios-install" }) === "install");
ok("no web push: says so", notifyCardState({ ...card, support: "unsupported" }) === "unsupported");
ok("server without VAPID: nothing", notifyCardState({ ...card, serverEnabled: false }) === "hidden");
ok("dismissed: nothing", notifyCardState({ ...card, dismissed: true }) === "hidden");
ok("dismissed unsupported: nothing", notifyCardState({ ...card, dismissed: true, support: "unsupported" }) === "hidden");
ok(
  "dismissed but on still shows on",
  notifyCardState({ ...card, dismissed: true, permission: "granted", subscribed: true }) === "on",
);
ok("phone app signed in: the app covers it", notifyCardState({ ...card, host: "phone-app", signedIn: true }) === "app");
ok(
  "phone app never shows the browser prompt, even with web push",
  notifyCardState({ ...card, host: "phone-app", signedIn: false }) === "hidden",
);
ok(
  "phone app, even with the server's VAPID off",
  notifyCardState({ ...card, host: "phone-app", signedIn: true, serverEnabled: false }) === "app",
);
ok("phone app dismissed: nothing", notifyCardState({ ...card, host: "phone-app", signedIn: true, dismissed: true }) === "hidden");
// ---- unblocking, per browser
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0";
ok("Mac Safari: Safari settings", unblockHint(MAC_SAFARI).startsWith("Open Safari → Settings"));
ok("Chrome is not Safari", unblockHint(CHROME_MAC).includes("address bar"), unblockHint(CHROME_MAC));
ok("Firefox", unblockHint(FIREFOX).includes("Notifications block"));
ok("Android Chrome: site settings", unblockHint(ANDROID_CHROME).includes("Site settings"));
ok("iPhone (Home Screen app): iOS Settings", unblockHint(IPHONE_17).startsWith("Open Settings → Notifications"));
ok("iPad as a Mac: iOS Settings", unblockHint(IPAD_DESKTOP, 5).startsWith("Open Settings → Notifications"));

ok("desktop app: nothing", notifyCardState({ ...card, host: "desktop-app", signedIn: true }) === "hidden");

console.log(`push: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
