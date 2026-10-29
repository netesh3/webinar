/**
 * Which site the app wraps, and which URLs count as "the site".
 *
 * The start URL defaults to production. Point it at staging (or a local dev
 * server) with the WEBINARLIV_URL environment variable or a
 * `--webinarliv-url=<url>` argument. The host of that URL is trusted in
 * addition to webinarliv.com.
 */

export const PROTOCOL = "webinarliv";
export const DEFAULT_URL = "https://webinarliv.com";

/** The root domain whose host and every subdomain belong to the site. */
const SITE_DOMAIN = "webinarliv.com";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function resolveStartUrl(): URL {
  const raw = argValue("webinarliv-url") ?? process.env.WEBINARLIV_URL ?? DEFAULT_URL;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") return url;
  } catch {
    // fall through
  }
  console.warn(`[config] ignoring invalid start URL ${JSON.stringify(raw)}`);
  return new URL(DEFAULT_URL);
}

export const START_URL = resolveStartUrl();

/** Hosts the configured start URL adds (e.g. staging.webinarliv.com, localhost:3000). */
const EXTRA_HOST = START_URL.hostname;

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * True for URLs that belong to the site: webinarliv.com, any subdomain (which
 * includes recordings.webinarliv.com), and the configured start host. Only
 * https, except plain http for a localhost start URL during development.
 */
export function isSiteUrl(url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol === "https:" && hostMatches(u.hostname, SITE_DOMAIN)) return true;
  if (u.hostname === EXTRA_HOST && u.protocol === START_URL.protocol) return true;
  return false;
}

/** Same as isSiteUrl, for an origin string such as "https://webinarliv.com". */
export function isSiteOrigin(origin: string): boolean {
  return isSiteUrl(origin.endsWith("/") ? origin : `${origin}/`);
}

/**
 * Third-party hosts an integration or payment flow passes through. They may
 * load inside the app (top-level navigation or a popup) because the flow has
 * to come back to the site with its cookies; anything else leaves for the
 * system browser.
 *
 *  - Razorpay checkout: its 3-D Secure / net-banking popups
 *  - Google and Zoom OAuth for a page that still navigates to them in the
 *    window (a site build older than the connect hand-off)
 *
 * Continue with Google, Connect Zoom, Connect YouTube and the Drive picker no
 * longer pass through here: they run in the system browser (isSignInStartUrl,
 * isConnectStartUrl) and come back through webinarliv://auth and
 * webinarliv://connect (29 Oct 2026).
 */
const FLOW_DOMAINS = ["accounts.google.com", "accounts.youtube.com", "zoom.us", "razorpay.com"];

export function isFlowUrl(url: string): boolean {
  const u = parse(url);
  if (!u || u.protocol !== "https:") return false;
  return FLOW_DOMAINS.some((d) => hostMatches(u.hostname, d));
}

/** The site's Google sign-in start, the one URL openSignIn hands to the system browser. */
export function isSignInStartUrl(url: string): boolean {
  const u = parse(url);
  return !!u && isSiteUrl(u.toString()) && u.pathname === "/api/auth/google/start" &&
    u.searchParams.get("app") === "desktop";
}

/**
 * The site's connect start for Zoom, YouTube or the Drive picker, with a one-time ticket: the
 * one kind of URL openConnect hands to the system browser (web/lib/app-connect.ts). The
 * ticket is what lets that browser, which has no session, act for the app's account once.
 */
export function isConnectStartUrl(url: string): boolean {
  const u = parse(url);
  if (!u || !isSiteUrl(u.toString())) return false;
  if (!/^\/api\/integrations\/(zoom|youtube|drive)\/app-start$/.test(u.pathname)) return false;
  const ticket = u.searchParams.get("ticket") ?? "";
  return u.searchParams.get("app") === "desktop" && /^[A-Za-z0-9_-]{32,128}$/.test(ticket) && !u.username && !u.password;
}

/** The page that finishes a sign-in handed back through webinarliv://auth/complete. */
export function isAuthCompleteUrl(url: string): boolean {
  const u = parse(url);
  return !!u && isSiteUrl(u.toString()) && u.pathname === "/auth/complete";
}

/** The page that finishes a connect handed back through webinarliv://connect/complete. */
export function isConnectCompleteUrl(url: string): boolean {
  const u = parse(url);
  return !!u && isSiteUrl(u.toString()) && u.pathname === "/connect/complete";
}

/**
 * webinarliv://connect/picked: the Drive picker in the system browser is done. It opens
 * nothing (the room that asked collects the pick itself); the app only comes forward.
 */
export function isFocusOnlyLink(arg: string): boolean {
  const u = parse(arg);
  return !!u && u.protocol === `${PROTOCOL}:` && u.hostname.toLowerCase() === "connect" && u.pathname === "/picked";
}

/** Schemes that may be handed to the OS (shell.openExternal). */
export function isExternalSafe(url: string): boolean {
  const u = parse(url);
  return !!u && ["https:", "http:", "mailto:", "tel:"].includes(u.protocol);
}

/**
 * Turns a deep link or a command-line argument into a site URL to open, or
 * null when it is not one of ours.
 *
 *   webinarliv://join/<path>                      -> <site>/<path>
 *   webinarliv://open?url=https://webinarliv.com/x -> that URL (site URLs only)
 *   webinarliv://open?path=/x                      -> <site>/x
 *   webinarliv://open                              -> <site>/
 *   webinarliv://auth/complete?code=c              -> <site>/auth/complete?code=c
 *   webinarliv://connect/complete?code=c&provider=zoom
 *                                                  -> <site>/connect/complete?code=c&provider=zoom
 *   https://webinarliv.com/...                     -> as is
 *
 * auth/complete is the end of Continue with Google (web/lib/app-auth.ts), and
 * connect/complete the end of Connect Zoom / YouTube (web/lib/app-connect.ts):
 * only the code or error, and the provider's name, are carried over.
 */
export function resolveLaunchTarget(arg: string): string | null {
  const u = parse(arg);
  if (!u) return null;

  if (u.protocol === "https:" || u.protocol === "http:") {
    return isSiteUrl(u.toString()) ? u.toString() : null;
  }
  if (u.protocol !== `${PROTOCOL}:`) return null;

  // webinarliv://join/w/abc parses as host "join", pathname "/w/abc".
  const action = u.hostname.toLowerCase();
  if (action === "join") {
    // Collapse leading slashes so "//evil.example" can't become a host.
    const target = new URL(`/${u.pathname.replace(/^\/+/, "")}`, START_URL.origin);
    target.search = u.search;
    target.hash = u.hash;
    return isSiteUrl(target.toString()) ? target.toString() : null;
  }
  if (action === "auth") {
    if (u.pathname !== "/complete") return null;
    const target = new URL("/auth/complete", START_URL.origin);
    const code = u.searchParams.get("code");
    const error = u.searchParams.get("error");
    if (code && /^[A-Za-z0-9_-]{1,128}$/.test(code)) target.searchParams.set("code", code);
    else if (error && /^[a-z_]{1,32}$/.test(error)) target.searchParams.set("error", error);
    else return null;
    return target.toString();
  }
  if (action === "connect") {
    // connect/picked opens nothing: see isFocusOnlyLink.
    if (u.pathname !== "/complete") return null;
    const target = new URL("/connect/complete", START_URL.origin);
    const code = u.searchParams.get("code");
    const error = u.searchParams.get("error");
    const provider = u.searchParams.get("provider");
    if (code && /^[A-Za-z0-9_-]{1,128}$/.test(code)) target.searchParams.set("code", code);
    else if (error && /^[a-z_]{1,32}$/.test(error)) target.searchParams.set("error", error);
    else return null;
    if (provider && /^(zoom|youtube|drive)$/.test(provider)) target.searchParams.set("provider", provider);
    return target.toString();
  }
  if (action === "open" || action === "") {
    const nested = u.searchParams.get("url");
    if (nested) return isSiteUrl(nested) ? new URL(nested).toString() : null;
    const path = u.searchParams.get("path");
    if (path && path.startsWith("/") && !path.startsWith("//")) {
      const target = new URL(path, START_URL.origin).toString();
      return isSiteUrl(target) ? target : null;
    }
    return new URL("/", START_URL.origin).toString();
  }
  return null;
}

/** First argument in argv that resolves to a site URL. */
export function findLaunchTarget(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith("--")) continue;
    const target = resolveLaunchTarget(arg);
    if (target) return target;
  }
  return null;
}
