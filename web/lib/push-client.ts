/* Web Push, the browser side: the service worker, the subscription, the API calls, and the
 * install prompt Chrome hands us once.
 *
 * Nothing here runs on page load except registering /sw.js (no prompt) and listening for
 * beforeinstallprompt. Notification permission is only ever requested from a click — a
 * browser that is asked on load learns to ignore the site, and Safari refuses outright.
 */

import type {
  PushPreference,
  PushPreferencesResponse,
  PushPublicKeyResponse,
  PushSubscribeResponse,
  PushTestResponse,
  StatusResponse,
} from "./api-types";
import { del, fresh, post, put, request } from "./http";
import { pushSupport, subscribeBody, urlBase64ToUint8Array, type PushEnv, type PushSupport } from "./push";

export const pushApi = {
  publicKey: () => request<PushPublicKeyResponse>("/api/push/public-key", fresh),
  subscribe: (body: unknown) => post<PushSubscribeResponse>("/api/push/subscribe", body),
  unsubscribe: (endpoint: string, joinKey?: string) =>
    del<StatusResponse>("/api/push/subscribe", { endpoint, ...(joinKey ? { joinKey } : {}) }),
  preferences: () => request<PushPreferencesResponse>("/api/push/preferences", fresh),
  setPreferences: (preferences: PushPreference[]) =>
    put<PushPreferencesResponse>("/api/push/preferences", { preferences }),
  test: () => post<PushTestResponse>("/api/push/test"),
};

// ------------------------------------------------------------------ environment

type NavigatorStandalone = Navigator & { standalone?: boolean };

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    (navigator as NavigatorStandalone).standalone === true
  );
}

export function pushEnv(): PushEnv | null {
  if (typeof window === "undefined") return null;
  return {
    ua: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    notification: "Notification" in window,
    standalone: isStandalone(),
  };
}

export function currentPushSupport(): PushSupport {
  const env = pushEnv();
  return env ? pushSupport(env) : "unsupported";
}

export function currentPermission(): NotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "default";
  return Notification.permission;
}

// ------------------------------------------------------------------ service worker

let registering: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers /sw.js once per page. Never prompts for anything. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  if (!registering) {
    registering = navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => null);
  }
  return registering;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker();
  if (!reg || !("pushManager" in reg)) return null;
  return reg.pushManager.getSubscription().catch(() => null);
}

export class PushError extends Error {
  constructor(
    readonly code: "unsupported" | "off" | "denied" | "failed",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Asks for permission (from a click), subscribes this browser and tells the server.
 * With a join key the subscription is scoped to that registration; signed in, it is the
 * account's as well.
 */
export async function enablePush(joinKey?: string): Promise<PushSubscription> {
  if (currentPushSupport() !== "supported") {
    throw new PushError("unsupported", "This browser can't get notifications.");
  }
  const key = await pushApi.publicKey();
  if (!key.enabled || !key.publicKey) {
    throw new PushError("off", "Notifications aren't set up on this server.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushError("denied", "Notifications are blocked for this site.");
  }
  const reg = await registerServiceWorker();
  if (!reg) throw new PushError("unsupported", "This browser can't get notifications.");
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key.publicKey),
    });
  }
  const body = subscribeBody(sub.toJSON(), navigator.userAgent, joinKey);
  if (!body) throw new PushError("failed", "The browser returned an incomplete subscription.");
  await pushApi.subscribe(body);
  return sub;
}

/** Stops this browser hearing from the account (or, with a join key, that registration). */
export async function disablePush(joinKey?: string): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await pushApi.unsubscribe(sub.endpoint, joinKey).catch(() => undefined);
  // A registration opt-in leaves the browser subscribed for the account and other webinars.
  if (!joinKey) await sub.unsubscribe().catch(() => false);
}

// ------------------------------------------------------------------ install prompt

/** Chrome's BeforeInstallPromptEvent, which TypeScript's DOM types do not include. */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Starts listening; call once, early (components/pwa.tsx PwaBoot). */
export function captureInstallPrompt(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    // Keep Chrome's mini-infobar from appearing on its own: the menu item offers it instead.
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    emit();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installed = true;
    emit();
  });
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A snapshot for useSyncExternalStore: whether a prompt is waiting, and whether we installed. */
export function installSnapshot(): string {
  return `${deferred ? 1 : 0}${installed ? 1 : 0}`;
}

export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  emit();
  await e.prompt();
  const choice = await e.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  return choice.outcome === "accepted";
}
