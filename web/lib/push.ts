/* Web Push, the decisions: can this browser get push at all, and what should the opt-in show.
 *
 * Pure — everything takes what the browser reported as plain values — so it runs in the node
 * tests next to it (lib/push.test.mts). The browser side that calls these is
 * lib/push-client.ts; the components are components/pwa.tsx.
 */

import { isAndroid, isIOS } from "./device.ts";

/** What the page could detect about the browser. */
export type PushEnv = {
  ua: string;
  maxTouchPoints?: number;
  /** "serviceWorker" in navigator */
  serviceWorker: boolean;
  /** "PushManager" in window */
  pushManager: boolean;
  /** "Notification" in window */
  notification: boolean;
  /** Running as an installed app (display-mode: standalone, or navigator.standalone on iOS). */
  standalone: boolean;
};

/**
 * Whether this browser can be subscribed.
 *
 *  - "supported": ask for permission and subscribe.
 *  - "ios-install": iPhone/iPad on iOS 16.4+ in a Safari tab. Push exists, but only for a site
 *    added to the Home Screen, so the opt-in explains how to install instead.
 *  - "unsupported": nothing to offer (older iOS, an in-app browser, no service workers).
 */
export type PushSupport = "supported" | "ios-install" | "unsupported";

/** The iOS version in a user agent ("OS 16_4" → 16.4), or null when it is not iOS. */
export function iosVersion(ua: string, maxTouchPoints = 0): number | null {
  if (!isIOS(ua, maxTouchPoints)) return null;
  const m = /OS (\d+)[_.](\d+)/.exec(ua);
  if (m) return Number(m[1]) + Number(m[2]) / 10;
  // iPadOS reports a Mac; its Safari version tracks the OS.
  const v = /Version\/(\d+)(?:\.(\d+))?/.exec(ua);
  return v ? Number(v[1]) + Number(v[2] ?? 0) / 10 : null;
}

export function pushSupport(env: PushEnv): PushSupport {
  const ios = iosVersion(env.ua, env.maxTouchPoints ?? 0);
  if (ios !== null) {
    if (ios < 16.4) return "unsupported";
    // iOS exposes PushManager only inside the Home Screen app.
    if (!env.standalone) return env.serviceWorker ? "ios-install" : "unsupported";
  }
  return env.serviceWorker && env.pushManager && env.notification ? "supported" : "unsupported";
}

/** What an opt-in button shows. */
export type OptInState =
  /** Push off on the server, or the browser cannot do it: show nothing. */
  | "hidden"
  /** iOS in Safari: web push is not available; point at the native app. */
  | "install"
  /** Not asked yet, or asked and not subscribed: the button. */
  | "ask"
  /** Working: a request is in flight. */
  | "busy"
  /** The browser (or the person) has said no: how to undo it. */
  | "blocked"
  /** Subscribed. */
  | "on";

export function optInState(input: {
  serverEnabled: boolean;
  support: PushSupport;
  /** Notification.permission, or "default" when unknown. */
  permission: NotificationPermission;
  subscribed: boolean;
  busy?: boolean;
}): OptInState {
  if (!input.serverEnabled || input.support === "unsupported") return "hidden";
  if (input.support === "ios-install") return "install";
  if (input.busy) return "busy";
  if (input.permission === "denied") return "blocked";
  if (input.permission === "granted" && input.subscribed) return "on";
  return "ask";
}

/** A VAPID public key (base64url) as the bytes PushManager.subscribe wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The browser's subscription as POST /api/push/subscribe wants it, or null if incomplete. */
export function subscribeBody(
  json: { endpoint?: string; keys?: Record<string, string> },
  ua: string,
  joinKey?: string,
): { endpoint: string; keys: { p256dh: string; auth: string }; ua: string; joinKey?: string } | null {
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return {
    endpoint: json.endpoint,
    keys: { p256dh, auth },
    ua: ua.slice(0, 300),
    ...(joinKey ? { joinKey } : {}),
  };
}

/** localStorage key remembering that this browser opted in for one registration. */
export function optInKey(joinKey: string): string {
  return `webcast.push.reg.${joinKey}`;
}

/** How to allow notifications again once they were blocked, for this browser (31 Oct 2026).
 *  A page cannot ask twice: only the person can undo a "Block", in the browser's settings. */
export function unblockHint(ua: string, maxTouchPoints = 0): string {
  if (isIOS(ua, maxTouchPoints)) return "Open Settings → Notifications, find Webinar Liv and turn on Allow Notifications.";
  if (isAndroid(ua)) {
    return "Tap ⋮ → Settings → Site settings → Notifications, find this site and choose Allow.";
  }
  if (/Firefox\//.test(ua)) {
    return "Click the icon left of the address bar, clear the Notifications block, then reload.";
  }
  if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) {
    return "Open Safari → Settings → Websites → Notifications, and set this site to Allow.";
  }
  return "Click the icon left of the address bar, set Notifications to Allow, then reload.";
}

/** localStorage key remembering "Not now" on the notify card for one webinar or meeting. */
export function dismissKey(slug: string): string {
  return `webcast.push.dismissed.${slug}`;
}

/** Where the page is running, as far as push goes. */
export type PushHost =
  /** An ordinary browser tab (or a Home Screen web app). */
  | "browser"
  /** Our phone app (the Capacitor shell's user agent): app push, for a signed-in account. */
  | "phone-app"
  /** Our desktop app (window.webinarlivDesktop): Electron has no push service. */
  | "desktop-app";

export function pushHost(input: { nativeAppUA: boolean; desktopBridge: boolean }): PushHost {
  if (input.desktopBridge) return "desktop-app";
  if (input.nativeAppUA) return "phone-app";
  return "browser";
}

/** What the "Get notified when it starts" card after registering, or while waiting in a
 *  meeting's lobby, shows (31 Oct 2026). The opt-in states, plus:
 *
 *   "app"          in our phone app, signed in: the app's own push already covers this
 *                  session, so no browser prompt, just a line saying so
 *   "unsupported"  this browser cannot get web push (an in-app browser, old iOS): say so,
 *                  and where the reminder comes from instead
 *
 *  Hidden: inside the desktop app (Electron has no push, and there is no browser prompt to
 *  offer), in the phone app signed out (app push is an account's), when the server has no
 *  VAPID keys, and once "Not now" was pressed for this session, unless it is already on. */
export type NotifyCardState = OptInState | "app" | "unsupported";

export function notifyCardState(input: {
  host: PushHost;
  signedIn: boolean;
  dismissed: boolean;
  serverEnabled: boolean;
  support: PushSupport;
  permission: NotificationPermission;
  subscribed: boolean;
  busy?: boolean;
}): NotifyCardState {
  if (input.host === "desktop-app") return "hidden";
  if (input.host === "phone-app") return input.signedIn && !input.dismissed ? "app" : "hidden";
  if (!input.serverEnabled) return "hidden";
  const s = optInState(input);
  if (s === "on") return "on";
  if (input.dismissed) return "hidden";
  return s === "hidden" ? "unsupported" : s;
}
