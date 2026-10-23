/* Web Push and install, the decisions: can this browser get push at all, what should the
 * opt-in show, and is there an install prompt to offer.
 *
 * Pure — everything takes what the browser reported as plain values — so it runs in the node
 * tests next to it (lib/push.test.mts). The browser side that calls these is
 * lib/push-client.ts; the components are components/pwa.tsx.
 */

import { isIOS } from "./device.ts";

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
  /** iOS in Safari: "Add to Home Screen first". */
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

/** Which install affordance to offer. */
export type InstallKind = "none" | "prompt" | "ios";

export function installKind(input: {
  ua: string;
  maxTouchPoints?: number;
  standalone: boolean;
  /** A beforeinstallprompt event was captured and not yet used. */
  deferredPrompt: boolean;
}): InstallKind {
  if (input.standalone) return "none";
  if (input.deferredPrompt) return "prompt";
  // Safari on iOS never fires beforeinstallprompt; Add to Home Screen is in the Share sheet.
  if (isIOS(input.ua, input.maxTouchPoints ?? 0)) return "ios";
  return "none";
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
