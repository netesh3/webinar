/* What kind of browser a visitor is in, for the handful of decisions that depend on it.
 *
 * Kept free of React and the DOM (everything takes a user agent string) so it runs in
 * the plain node tests next to it. The `current*` helpers at the bottom read navigator
 * and are false on the server.
 */

/** The in-app browser of a social / messaging app, or null for a real browser.
 *
 * These are WebViews: a link tapped inside Instagram or Facebook opens in the app's own
 * browser, not Chrome or Safari. Google refuses OAuth in them outright ("Error 403:
 * disallowed_useragent"), so a Gmail address sent to Google sign-in from here lands on
 * an error page and never registers. They also keep their own cookies and storage,
 * separate from the phone's real browser.
 *
 * WhatsApp is deliberately not listed: on Android it opens links in Chrome Custom Tabs
 * and on iOS in Safari's view controller, both of which are the real browser engine and
 * allowed by Google. Its user agent carries no marker anyway.
 */
export function inAppBrowserName(ua: string): string | null {
  if (!ua) return null;
  // Our own Android / iOS app (apps/mobile) is a WebView too, but not somebody else's:
  // no "open this in Chrome" note there. Google sign-in is still unavailable inside it,
  // which isNativeAppUA lets the registration form account for separately.
  if (isNativeAppUA(ua)) return null;
  if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A|\[FB/i.test(ua)) return "Facebook";
  if (/Instagram/i.test(ua)) return "Instagram";
  if (/LinkedInApp/i.test(ua)) return "LinkedIn";
  if (/Snapchat/i.test(ua)) return "Snapchat";
  if (/\bLine\//i.test(ua)) return "LINE";
  if (/musical_ly|BytedanceWebview|TikTok/i.test(ua)) return "TikTok";
  if (/Twitter/i.test(ua)) return "X";
  if (/Telegram/i.test(ua)) return "Telegram";
  // A generic Android WebView: "; wv)" in the platform part. Chrome Custom Tabs do not
  // carry it, so WhatsApp and Gmail links opened that way are not caught here.
  if (/Android/i.test(ua) && /;\s*wv\)/i.test(ua)) return "this app";
  return null;
}

/** The Webinar Liv mobile app (apps/mobile/capacitor.config.ts appendUserAgent). */
export function isNativeAppUA(ua: string): boolean {
  return /\bWebinarLivApp\//.test(ua);
}

/** The iOS build of that app, where Apple's in-app purchase rule applies (App Store
 *  guideline 3.1.1): no pricing, no checkout, no link out to buy (29 Oct 2026).
 *
 *  The app ships on iOS and Android only, so "our marker, not Android" is iOS. The
 *  device part of the UA is not used: an iPad's WKWebView asks for desktop sites and
 *  reports "Macintosh", which a plain iPhone|iPad test would miss. The desktop app
 *  (apps/desktop) does not send WebinarLivApp/, so it keeps purchasing. */
export function isIOSAppUA(ua: string): boolean {
  return isNativeAppUA(ua) && !isAndroid(ua);
}

/** Which way the page is told it is in the iOS app, given what it can read: the bridge
 *  Capacitor injects (authoritative once there), otherwise the user agent. Pure, so
 *  the node tests cover it; currentIsIOSApp feeds it the real window. */
export function iosAppFrom(platform: string | null, ua: string): boolean {
  if (platform === "ios") return true;
  if (platform === "android" || platform === "web") return false;
  return isIOSAppUA(ua);
}

/* Set before first paint by appStoreBootScript (app/layout.tsx), so links that must not
 * show in the iOS app are hidden by CSS before React hydrates (globals.css,
 * .ios-app-hidden / .ios-app-only). */
export const IOS_APP_ATTR = "data-ios-app";

/** Viewport extras for the Capacitor app. iOS zooms the document when a focused
 *  field is under 16px; the live room is `overflow: hidden`, so there is no
 *  pinch-out. Locking scale on the native UA stops that without disabling zoom
 *  on Safari. Pair with the 16px field rule in globals.css. */
export function nativeAppViewport(ua: string): { maximumScale: 1; userScalable: false } | Record<string, never> {
  if (!isNativeAppUA(ua)) return {};
  return { maximumScale: 1, userScalable: false };
}

/** The inline script for <head>: marks <html> in the iOS app. Same test as isIOSAppUA,
 *  inlined because it runs before any bundle. */
export function appStoreBootScript(): string {
  return `try{var u=navigator.userAgent||"";if(/\\bWebinarLivApp\\//.test(u)&&!/Android/i.test(u))document.documentElement.setAttribute("${IOS_APP_ATTR}","1")}catch(e){}`;
}

export function isAndroid(ua: string): boolean {
  return /Android/i.test(ua);
}

export function isIOS(ua: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPod|iPad/i.test(ua)) return true;
  // iPadOS 13+ reports as a Mac; a touchscreen is what gives it away.
  return /Macintosh/i.test(ua) && maxTouchPoints > 1;
}

/** A phone or tablet, by user agent. Coarse on purpose: it picks defaults, never access. */
export function isMobileUA(ua: string, maxTouchPoints = 0): boolean {
  return isAndroid(ua) || isIOS(ua, maxTouchPoints) || /Mobile/i.test(ua);
}

/* Phone, tablet or desktop, for the decisions where a tablet is not a phone (31 Oct 2026).
 *
 * isMobileUA lumps them together, and a screen share was capped on that: an iPad presenting
 * got the phone's capture. A tablet's screen is a laptop's, so it shares like one.
 *   phone    iPhone / iPod, Android with "Mobile" (Android's own phone marker), any other
 *            "Mobile" UA
 *   tablet   iPad, iPadOS desktop mode (Macintosh + a touchscreen: macOS Safari reports
 *            maxTouchPoints 0 even with a touch display attached), Android without "Mobile"
 *   desktop  everything else
 * Android tablets in Chrome's "desktop site" mode send a Linux desktop UA and land in desktop,
 * which shares the same way, so the miss costs nothing. */
export type FormFactor = "phone" | "tablet" | "desktop";

export function deviceFormFactor(ua: string, maxTouchPoints = 0): FormFactor {
  if (/iPhone|iPod/i.test(ua)) return "phone";
  if (/iPad/i.test(ua)) return "tablet";
  if (isAndroid(ua)) return /Mobile/i.test(ua) ? "phone" : "tablet";
  if (/Macintosh/i.test(ua) && maxTouchPoints > 1) return "tablet";
  return /Mobile/i.test(ua) ? "phone" : "desktop";
}

/** An Android intent: URL that opens `url` in Chrome from inside a WebView.
 *  Falls back to the same URL if Chrome is not installed. */
export function androidChromeIntent(url: string): string {
  const u = new URL(url);
  const scheme = u.protocol.replace(":", "");
  // No fragment: the intent's own `#Intent;` is the URL's fragment, so a second one
  // would be read as part of it.
  const rest = `${u.host}${u.pathname}${u.search}`;
  return (
    `intent://${rest}#Intent;scheme=${scheme};package=com.android.chrome;` +
    `S.browser_fallback_url=${encodeURIComponent(url)};end`
  );
}

function ua(): string {
  return typeof navigator === "undefined" ? "" : navigator.userAgent || "";
}
function touch(): number {
  return typeof navigator === "undefined" ? 0 : navigator.maxTouchPoints || 0;
}

export function currentInAppBrowser(): string | null {
  return inAppBrowserName(ua());
}
export function currentIsNativeApp(): boolean {
  return isNativeAppUA(ua());
}
export function currentIsMobile(): boolean {
  return isMobileUA(ua(), touch());
}
/** True in the iOS app (see isIOSAppUA). False on the server. */
export function currentIsIOSApp(): boolean {
  if (typeof window === "undefined") return false;
  const c = (window as unknown as {
    Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string };
  }).Capacitor;
  const platform = c?.isNativePlatform?.() ? (c.getPlatform?.() ?? null) : null;
  return iosAppFrom(platform, ua());
}
export function currentIsAndroid(): boolean {
  return isAndroid(ua());
}

/** What the telemetry join event records about the device: enough to split the
 *  numbers by phone / in-app browser, no fingerprint. */
export function deviceSummary(): {
  mobile: boolean;
  os: "ios" | "android" | "other";
  inApp: string | null;
} {
  const agent = ua();
  return {
    mobile: isMobileUA(agent, touch()),
    os: isIOS(agent, touch()) ? "ios" : isAndroid(agent) ? "android" : "other",
    inApp: inAppBrowserName(agent),
  };
}
