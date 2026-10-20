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
export function currentIsMobile(): boolean {
  return isMobileUA(ua(), touch());
}
export function currentIsAndroid(): boolean {
  return isAndroid(ua());
}
