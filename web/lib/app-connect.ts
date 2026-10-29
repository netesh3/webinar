/* Connect Zoom, Connect YouTube and the Drive picker inside the desktop and mobile apps
 * (29 Oct 2026).
 *
 * Their OAuth cannot run in the app's webview (Google refuses embedded webviews; the phones
 * send off-site navigation to the system browser, which has no session), so inside an app:
 *
 *   Zoom, YouTube
 *     1. startAppConnect (this page, signed in): POST /api/host/integrations/{p}/app-ticket
 *        gives a start URL with a one-time ticket, which opens in the system browser
 *        (window.webinarlivDesktop.openConnect; @capacitor/browser on the phones).
 *     2. The provider, then its callback, which parks the provider's code and sends that
 *        browser to /connect/app-return#code=… (app/connect/app-return). That page opens
 *        webinarliv://connect/complete?code=…&provider=…
 *     3. The app loads /connect/complete?code=… in its webview (app/connect/complete), which
 *        POSTs the code to /api/host/integrations/app/complete: the API connects the provider
 *        only for this webview's own account, then the page goes back to where it started.
 *
 *   Drive ("Pick from Drive" in a room)
 *     1. pickFromDriveInApp: a drive ticket, opened the same way. The start route sets a pick
 *        cookie in the system browser and shows /connect/drive, where Google's Picker runs
 *        with the person's own Google session. The pick (and the short read token) goes to
 *        the API, and the page opens webinarliv://connect/picked, which only brings the app
 *        forward: the room is live and is not navigated anywhere.
 *     2. The room polls GET /api/host/integrations/drive/app-pick/{id} with its session,
 *        collects the pick once and downloads the file itself, as on the web.
 *
 * Outside an app every function here is a no-op that returns false/null, and the pages keep
 * their ordinary links. See api/internal/api/app_connect.go for the server's half.
 */

import { currentAppKind, type AppKind } from "./app-auth.ts";

export type ConnectProvider = "zoom" | "youtube";
export type AppConnectProvider = ConnectProvider | "drive";

// ------------------------------------------------------------------ pure

/** The provider and return path of a web connect link (/api/host/{zoom|youtube}/connect),
 *  relative or absolute, or null for any other link. */
export function connectFromHref(href: string): { provider: ConnectProvider; ret: string } | null {
  let u: URL;
  try {
    u = new URL(href, "https://webinarliv.invalid");
  } catch {
    return null;
  }
  const m = /^\/api\/host\/(zoom|youtube)\/connect$/.exec(u.pathname);
  if (!m) return null;
  const ret = u.searchParams.get("return") ?? "";
  return { provider: m[1] as ConnectProvider, ret: safeReturn(ret) };
}

/** A same-site path to come back to; the server applies the same rule (safeReturnPath). */
export function safeReturn(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("://")) {
    return "/settings";
  }
  return raw;
}

/** What /connect/app-return got in its fragment. */
export function parseConnectFragment(hash: string): {
  code: string;
  error: string;
  app: string;
  provider: string;
} {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  return {
    code: q.get("code") ?? "",
    error: q.get("error") ?? "",
    app: q.get("app") ?? "",
    provider: q.get("provider") ?? "",
  };
}

const PROVIDER_RE = /^(zoom|youtube|drive)$/;

/** The link back into the app after a connect. Only a short code or an error word, and the
 *  provider's name, ever go in it. */
export function connectCompleteLink(result: { code?: string; error?: string; provider: string }): string {
  const q = new URLSearchParams();
  if (result.code) q.set("code", result.code);
  else q.set("error", /^[a-z_]{1,32}$/.test(result.error ?? "") ? result.error! : "provider");
  if (PROVIDER_RE.test(result.provider)) q.set("provider", result.provider);
  return `webinarliv://connect/complete?${q.toString()}`;
}

/** The link the Drive picker page opens when it is done: it only brings the app forward. */
export const DRIVE_PICKED_LINK = "webinarliv://connect/picked";

export function providerLabel(provider: string): string {
  if (provider === "zoom") return "Zoom";
  if (provider === "youtube") return "YouTube";
  if (provider === "drive") return "Google Drive";
  return "that service";
}

/** What to tell somebody whose connect came back with an error word. */
export function connectErrorMessage(provider: string, error: string): string {
  const name = providerLabel(provider);
  switch (error) {
    case "denied":
      return `${name} wasn't connected: access was declined.`;
    case "expired":
      return "That took too long. Start again from the app.";
    case "used":
      return "That link was already used. Start again from the app.";
    case "unavailable":
      return `${name} isn't available for this account.`;
    case "state":
      return "That connection didn't come back to the browser it started in. Start again from the app.";
    default:
      return `${name} didn't finish connecting. Try again from the app.`;
  }
}

// ------------------------------------------------------------------ runtime

type DesktopBridge = { openConnect?: (url: string) => void };
type CapacitorLike = {
  isPluginAvailable?: (name: string) => boolean;
  Plugins?: Record<string, { open?: (o: { url: string }) => Promise<void> } | undefined>;
};

/** Which app can hand a connect to the system browser. The desktop app needs openConnect
 *  (older builds only allow the sign-in URL through); the phones need @capacitor/browser. */
export function connectAppKind(): AppKind | null {
  const app = currentAppKind();
  if (!app) return null;
  if (app === "desktop") {
    const d = (window as unknown as { webinarlivDesktop?: DesktopBridge }).webinarlivDesktop;
    return typeof d?.openConnect === "function" ? "desktop" : null;
  }
  const c = (window as unknown as { Capacitor?: CapacitorLike }).Capacitor;
  if (c?.isPluginAvailable?.("Browser") === false || !c?.Plugins?.Browser?.open) return null;
  return app;
}

async function openInSystemBrowser(app: AppKind, url: string): Promise<void> {
  if (app === "desktop") {
    (window as unknown as { webinarlivDesktop: Required<DesktopBridge> }).webinarlivDesktop.openConnect(url);
    return;
  }
  const c = (window as unknown as { Capacitor: Required<CapacitorLike> }).Capacitor;
  await c.Plugins.Browser!.open!({ url });
}

async function mintTicket(
  provider: AppConnectProvider,
  app: AppKind,
  ret: string,
): Promise<{ startUrl: string; id: string }> {
  const res = await fetch(`${window.location.origin}/api/host/integrations/${provider}/app-ticket`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app, return: ret }),
  });
  const body = (await res.json().catch(() => null)) as
    | { startUrl?: string; id?: string; message?: string }
    | null;
  if (!res.ok || !body?.startUrl || !body.id) {
    throw new Error(body?.message || `Couldn't start connecting ${providerLabel(provider)}. Try again.`);
  }
  return { startUrl: body.startUrl, id: body.id };
}

/** Starts Connect Zoom / Connect YouTube in the system browser. False when this is not an
 *  app that can (the caller then follows the ordinary link). */
export async function startAppConnect(provider: ConnectProvider, ret: string): Promise<boolean> {
  const app = connectAppKind();
  if (!app) return false;
  const { startUrl } = await mintTicket(provider, app, safeReturn(ret));
  await openInSystemBrowser(app, startUrl);
  return true;
}

/** For an <a href="/api/host/{zoom|youtube}/connect…"> click: inside an app, start the
 *  hand-off instead of following the link. Outside one, does nothing. */
export function interceptConnectClick(
  e: { preventDefault: () => void },
  href: string,
  onError?: (message: string) => void,
): void {
  const hit = connectFromHref(href);
  if (!hit || !connectAppKind()) return;
  e.preventDefault();
  startAppConnect(hit.provider, hit.ret).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : "Couldn't start connecting. Try again.";
    if (onError) onError(message);
    else window.alert(message);
  });
}

export type DriveAppPick = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  accessToken: string;
};

/** How long the room waits for a pick from the system browser. The server gives up at 15. */
const PICK_WAIT_MS = 15 * 60_000;
const PICK_POLL_MS = 2_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/** Inside an app, "Pick from Drive": the Picker runs in the system browser and the room
 *  collects the pick. Resolves null when this is not an app that can (the caller uses the
 *  in-page Picker), throws when it fails, and resolves "cancelled" when the room gave up. */
export async function pickFromDriveInApp(
  signal: AbortSignal,
): Promise<DriveAppPick | "cancelled" | null> {
  const app = connectAppKind();
  if (!app) return null;
  const { startUrl, id } = await mintTicket("drive", app, window.location.pathname);
  await openInSystemBrowser(app, startUrl);
  const until = Date.now() + PICK_WAIT_MS;
  while (!signal.aborted && Date.now() < until) {
    await sleep(PICK_POLL_MS, signal);
    if (signal.aborted) break;
    let res: Response;
    try {
      res = await fetch(`${window.location.origin}/api/host/integrations/drive/app-pick/${encodeURIComponent(id)}`, {
        credentials: "include",
        cache: "no-store",
        signal,
      });
    } catch {
      if (signal.aborted) break;
      continue; // A blip while the app was in the background: ask again.
    }
    if (res.status === 404) return "cancelled";
    const body = (await res.json().catch(() => null)) as
      | { status?: string; fileId?: string; name?: string; size?: number; mimeType?: string; accessToken?: string }
      | null;
    if (!res.ok) continue;
    if (body?.status === "picked" && body.fileId && body.accessToken) {
      return {
        id: body.fileId,
        name: body.name || "Drive video",
        size: body.size ?? 0,
        mimeType: body.mimeType || "video/mp4",
        accessToken: body.accessToken,
      };
    }
  }
  return "cancelled";
}
