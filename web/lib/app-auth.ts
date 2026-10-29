/* Continue with Google inside the desktop and mobile apps (29 Oct 2026).
 *
 * Google refuses OAuth in embedded webviews, so inside an app the sign-in runs in the SYSTEM
 * browser and comes back through webinarliv://. The whole round trip:
 *
 *   1. startAppGoogleSignIn (this page, in the app): a random verifier, kept in localStorage,
 *      and its SHA-256 (the challenge) go to /api/auth/google/start?app=…&challenge=…, which
 *      opens in the system browser (Electron's shell.openExternal; @capacitor/browser on the
 *      phones, SFSafariViewController / Custom Tabs, which Google allows).
 *   2. Google, then /api/auth/google/callback. It sets no cookie in that browser: it sends it
 *      to /auth/app-return#code=… (app/auth/app-return), which opens
 *      webinarliv://auth/complete?code=…
 *   3. The app catches the link (apps/desktop/src/config.ts; lib/native-bridge.ts on the
 *      phones) and loads /auth/complete?code=… in its own webview (app/auth/complete).
 *   4. That page POSTs the code and the verifier to /api/auth/app/exchange, which sets the
 *      session cookie in the webview, and goes where the sign-in was headed.
 *
 * The verifier never leaves the app's webview except in that last POST body, so a code caught
 * on the way (browser history, another app claiming webinarliv://) cannot be redeemed. See
 * api/internal/api/auth_app.go for the server's half.
 *
 * The pure pieces (URLs, fragments, the challenge) take their inputs as arguments so the node
 * test next to this file can run them; the rest reads window and is a no-op outside an app.
 */

export type AppKind = "desktop" | "ios" | "android";

/** Where the verifier waits between step 1 and step 4. One sign-in at a time. */
export const VERIFIER_KEY = "webinarliv.appAuth.verifier";
/** A verifier older than this is from an abandoned sign-in (the server's code lives 2 min). */
const VERIFIER_MAX_AGE_MS = 15 * 60_000;

// ------------------------------------------------------------------ pure

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes, base64url: RFC 7636's code_verifier (43 characters). */
export function makeVerifier(random: (a: Uint8Array) => Uint8Array = (a) => crypto.getRandomValues(a)): string {
  return base64url(random(new Uint8Array(32)));
}

/** S256: base64url(SHA-256(verifier)). The server compares the same (auth_app.go ChallengeFor). */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/** The start URL the system browser opens. */
export function appStartUrl(
  origin: string,
  opts: { next: string; loginHint?: string; app: AppKind; challenge: string },
): string {
  const q = new URLSearchParams();
  q.set("next", opts.next);
  if (opts.loginHint) q.set("login_hint", opts.loginHint);
  q.set("app", opts.app);
  q.set("challenge", opts.challenge);
  return `${origin}/api/auth/google/start?${q.toString()}`;
}

/** What /auth/app-return got in its fragment: a code, or an error, for which app. */
export function parseReturnFragment(hash: string): { code: string; error: string; app: string } {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  return { code: q.get("code") ?? "", error: q.get("error") ?? "", app: q.get("app") ?? "" };
}

/** The link back into the app. Only a short code or an error word ever goes in it. */
export function appCompleteLink(result: { code?: string; error?: string }): string {
  const q = new URLSearchParams();
  if (result.code) q.set("code", result.code);
  else q.set("error", result.error || "google");
  return `webinarliv://auth/complete?${q.toString()}`;
}

/** A redirect target from the exchange: a same-site path, else the fallback. */
export function safeNextPath(raw: string | null | undefined, fallback = "/"): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  return raw;
}

// ------------------------------------------------------------------ runtime

type DesktopBridge = { openSignIn?: (url: string) => void };
type CapacitorLike = {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, { open?: (o: { url: string }) => Promise<void> } | undefined>;
};

/** Which app this page runs in, if the app can hand a sign-in to the system browser. The
 *  desktop app before this change has no openSignIn, so it keeps the old in-window flow. */
export function currentAppKind(): AppKind | null {
  if (typeof window === "undefined") return null;
  const desktop = (window as unknown as { webinarlivDesktop?: DesktopBridge }).webinarlivDesktop;
  if (desktop && typeof desktop.openSignIn === "function") return "desktop";
  const c = (window as unknown as { Capacitor?: CapacitorLike }).Capacitor;
  if (c?.isNativePlatform?.()) {
    const p = c.getPlatform?.();
    if (p === "ios" || p === "android") return p;
  }
  return null;
}

/** Starts Continue with Google in the system browser. False when this is not an app (the
 *  caller then does the ordinary full-page redirect). */
export async function startAppGoogleSignIn(opts: { next: string; loginHint?: string }): Promise<boolean> {
  const app = currentAppKind();
  if (!app) return false;
  const verifier = makeVerifier();
  const challenge = await challengeFor(verifier);
  try {
    localStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, at: Date.now() }));
  } catch {
    // No storage, no way to finish: the ordinary redirect at least gets somewhere.
    return false;
  }
  const url = appStartUrl(window.location.origin, { ...opts, app, challenge });
  if (app === "desktop") {
    (window as unknown as { webinarlivDesktop: Required<DesktopBridge> }).webinarlivDesktop.openSignIn(url);
    return true;
  }
  const c = (window as unknown as { Capacitor?: CapacitorLike }).Capacitor;
  const browser = c?.isPluginAvailable?.("Browser") === false ? undefined : c?.Plugins?.Browser;
  if (browser?.open) {
    await browser.open({ url });
    return true;
  }
  /* A build without @capacitor/browser: load the start URL here. Its redirect to
   * accounts.google.com is not an allowed host, so Capacitor hands it to the system browser,
   * and the rest of the trip is the same. */
  window.location.assign(url);
  return true;
}

/** The verifier for this sign-in, taken out of storage (it is good for one exchange). */
export function takeVerifier(now = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(VERIFIER_KEY);
    localStorage.removeItem(VERIFIER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { verifier?: string; at?: number };
    if (!v.verifier || !v.at || now - v.at > VERIFIER_MAX_AGE_MS) return null;
    return v.verifier;
  } catch {
    return null;
  }
}
