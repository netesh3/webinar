/* In-app browser and mobile detection.
 *
 * Run: node --experimental-strip-types --no-warnings lib/device.test.mts
 */

import assert from "node:assert/strict";
import {
  IOS_APP_ATTR,
  androidChromeIntent,
  appStoreBootScript,
  inAppBrowserName,
  iosAppFrom,
  isIOS,
  isIOSAppUA,
  isMobileUA,
  isNativeAppUA,
  nativeAppViewport,
} from "./device.ts";

const instagramAndroid =
  "Mozilla/5.0 (Linux; Android 13; SM-A536E Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Instagram 312.0.0.32.112 Android";
const facebookIOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/444.0.0.36.111;FBBV/554617465]";
const plainWebView =
  "Mozilla/5.0 (Linux; Android 12; RMX3363; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0 Mobile Safari/537.36";
const chromeAndroid =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const safariIOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const chromeMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

assert.equal(inAppBrowserName(instagramAndroid), "Instagram");
assert.equal(inAppBrowserName(facebookIOS), "Facebook");
assert.equal(inAppBrowserName(plainWebView), "this app");
assert.equal(inAppBrowserName(chromeAndroid), null);
assert.equal(inAppBrowserName(safariIOS), null);
assert.equal(inAppBrowserName(chromeMac), null);
assert.equal(inAppBrowserName(""), null);

// Our own app (apps/mobile): a WebView, but never told to open itself in Chrome.
const ourAndroidApp = `${plainWebView} WebinarLivApp/1.0`;
const ourIOSApp =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WebinarLivApp/1.0";
assert.equal(inAppBrowserName(ourAndroidApp), null);
assert.equal(isNativeAppUA(ourAndroidApp), true);
assert.equal(isNativeAppUA(ourIOSApp), true);
assert.equal(isNativeAppUA(safariIOS), false);
assert.equal(isNativeAppUA(plainWebView), false);

// The iOS app, where nothing is sold (App Store guideline 3.1.1). iPad's WKWebView asks
// for desktop sites, so it reports a Mac; the marker without Android is what counts.
const ourIPadApp =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) WebinarLivApp/1.0";
const ourDesktopApp = `${chromeMac} WebinarLivDesktop/0.2.0`;
assert.equal(isIOSAppUA(ourIOSApp), true);
assert.equal(isIOSAppUA(ourIPadApp), true);
assert.equal(isIOSAppUA(ourAndroidApp), false, "Android keeps purchasing");
assert.equal(isIOSAppUA(ourDesktopApp), false, "the desktop app keeps purchasing");
assert.equal(isIOSAppUA(safariIOS), false, "Safari on an iPhone is the web, not the app");
assert.equal(isIOSAppUA(""), false);

// Capacitor's platform wins when the bridge is there; otherwise the UA decides.
assert.equal(iosAppFrom("ios", ""), true);
assert.equal(iosAppFrom("android", ourIOSApp), false);
assert.equal(iosAppFrom("web", ourIOSApp), false);
assert.equal(iosAppFrom(null, ourIOSApp), true);
assert.equal(iosAppFrom(null, ourAndroidApp), false);
assert.equal(iosAppFrom(null, safariIOS), false);

// The before-paint script marks <html> exactly where isIOSAppUA says so.
function bootMarks(ua: string): boolean {
  const attrs: Record<string, string> = {};
  const fakeDocument = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
  new Function("navigator", "document", appStoreBootScript())({ userAgent: ua }, fakeDocument);
  return attrs[IOS_APP_ATTR] === "1";
}
for (const ua of [ourIOSApp, ourIPadApp, ourAndroidApp, ourDesktopApp, safariIOS, chromeAndroid, ""]) {
  assert.equal(bootMarks(ua), isIOSAppUA(ua), `boot script vs isIOSAppUA for ${ua || "(empty)"}`);
}

assert.deepEqual(nativeAppViewport(ourIOSApp), { maximumScale: 1, userScalable: false });
assert.deepEqual(nativeAppViewport(ourAndroidApp), { maximumScale: 1, userScalable: false });
assert.deepEqual(nativeAppViewport(safariIOS), {});
assert.deepEqual(nativeAppViewport(chromeMac), {});

assert.equal(isMobileUA(chromeAndroid), true);
assert.equal(isMobileUA(safariIOS), true);
assert.equal(isMobileUA(chromeMac), false);
assert.equal(isIOS(chromeMac, 5), true, "iPadOS reports as a Mac with touch");

assert.equal(
  androidChromeIntent("https://webinarliv.com/webinars/abc?k=1#x"),
  "intent://webinarliv.com/webinars/abc?k=1#Intent;scheme=https;package=com.android.chrome;" +
    "S.browser_fallback_url=https%3A%2F%2Fwebinarliv.com%2Fwebinars%2Fabc%3Fk%3D1%23x;end",
);

console.log("device: ok");
