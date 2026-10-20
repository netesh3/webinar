/* In-app browser and mobile detection.
 *
 * Run: node --experimental-strip-types --no-warnings lib/device.test.mts
 */

import assert from "node:assert/strict";
import { androidChromeIntent, inAppBrowserName, isIOS, isMobileUA } from "./device.ts";

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
