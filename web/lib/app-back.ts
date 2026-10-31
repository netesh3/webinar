/* Where Back goes in the phone app (and anywhere else without browser chrome).
 *
 * The Capacitor WebView has no toolbar. Nested pages that a browser would leave
 * with the OS back gesture need an in-app parent, and Android's hardware back
 * has to be told the same thing or it exits the app. */

/** Sidebar / tab roots: Back would leave the product, so none is shown. */
const APP_ROOTS = new Set([
  "/",
  "/login",
  "/signup",
  "/host",
  "/host/meetings",
  "/host/audience",
  "/host/studio",
  "/host/knowledge",
  "/host/email",
  "/host/crm",
  "/host/messages",
  "/my-webinars",
  "/browse",
  "/home",
  "/settings",
  "/account",
]);

function strip(pathname: string): string {
  return (pathname.split(/[?#]/)[0] ?? "").replace(/\/+$/, "") || "/";
}

export function isAppRoot(pathname: string): boolean {
  return APP_ROOTS.has(strip(pathname));
}

/** The page Back should open, or null on a root (no Back). */
export function appParentPath(pathname: string): string | null {
  const path = strip(pathname);
  if (APP_ROOTS.has(path)) return null;

  const hostRoom = path.match(/^\/host\/([^/]+)\/room$/);
  if (hostRoom) return `/host/${hostRoom[1]}`;

  const attendeeRoom = path.match(/^\/webinars\/([^/]+)\/room$/);
  if (attendeeRoom) return `/webinars/${attendeeRoom[1]}`;

  const hostNested = path.match(/^\/host\/([^/]+)\/(.+)$/);
  if (hostNested) {
    const id = hostNested[1]!;
    const rest = hostNested[2]!;
    if (id === "new") return rest.startsWith("meeting") ? "/host/meetings" : "/host";
    return `/host/${id}`;
  }

  if (/^\/host\/[^/]+$/.test(path)) return "/host";
  if (path.startsWith("/webinars/")) return "/my-webinars";
  if (path.startsWith("/settings/")) return "/settings";
  if (path.startsWith("/account/")) return "/account";
  if (path.startsWith("/host/messages")) return "/host/messages";
  if (path.startsWith("/host/crm")) return "/host/crm";
  if (path.startsWith("/host/audience")) return "/host/audience";

  return "/host";
}

/** What Android's hardware back should do. `canGoBack` is the WebView history. */
export function nativeBackAction(input: {
  canGoBack: boolean;
  pathname: string;
}): "history" | "parent" | "exit" {
  if (input.canGoBack) return "history";
  return appParentPath(input.pathname) ? "parent" : "exit";
}
