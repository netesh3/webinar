import { NextResponse, type NextRequest } from "next/server";
import { decideAccess, type Viewer } from "@/lib/access";
import { isDevAuthBypass } from "@/lib/dev-bypass";

/* Route protection, applied before a page renders.
 *
 * The rule this enforces is in lib/access.ts, where it is tested. This file is the plumbing:
 * work out who is asking, then act on the answer.
 *
 * Why middleware and not a check inside each page. A page that renders and then decides has
 * already shipped its markup: the host dashboard's shell, its sidebar, the name of the webinar.
 * "Participants must never see the host dashboard" is not satisfied by a component that returns
 * null after the layout around it has drawn. Middleware runs first and answers with a 307, so
 * nothing host-shaped is ever sent to a browser that may not have it.
 *
 * This is the second of three layers and not the important one. The API is authoritative — every
 * host endpoint is behind requireHost or requireOwnership, and the stage room is behind
 * owner-or-panelist on that specific webinar. This layer exists so that guessing a URL produces
 * a redirect to somewhere useful instead of a dashboard frame around an error.
 */

/** Set by the API as httpOnly Path=/. On the managed Workers topology the Worker
 *  proxies /api so this cookie is first-party on the Worker host and readable
 *  here; middleware is server-side and never exposes it to page scripts. */
const SESSION_COOKIE = "webcast_session";

/* Where to ask who this is.
 *
 * The internal address, so the call stays on the compose network instead of going out through
 * Caddy and back in. Falls back to the public base for `next dev`, where there is no internal
 * network and both are the same host.
 */
const API_BASE =
  process.env.API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_API_BASE ||
  "http://localhost:8080";

/* How long to wait for the identity lookup.
 *
 * A short timeout on purpose: if the API is slow or down, the answer to "may this person open
 * the host dashboard" should be "no" quickly rather than a hung navigation. Failing closed on
 * a host route is safe — the page would not have worked anyway, since every request it makes
 * needs the same API.
 */
const LOOKUP_TIMEOUT_MS = 2_500;

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  /* Local UI preview only. NODE_ENV=development + NEXT_PUBLIC_DEV_BYPASS_AUTH=1.
   * Soft-allows host/admin routes so fixture screens can render without a cookie.
   * Production builds never hit this branch.
   *
   * Bypass fakes a signed-in host, so `/` must still skip marketing — same as a
   * real session. Turn NEXT_PUBLIC_DEV_BYPASS_AUTH off to preview the homepage. */
  if (isDevAuthBypass()) {
    if (pathname === "/" || pathname === "") {
      const url = request.nextUrl.clone();
      url.pathname = "/host";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  /* Anonymous until proven otherwise, and no network call unless there is a cookie to check.
   *
   * The cheap path matters: a signed-out visitor opening a host URL is answered from the
   * absence of a cookie alone. Only a request that actually carries a session pays for a
   * lookup. */
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const viewer: Viewer = token
    ? await identify(request)
    : { kind: "anonymous" };

  const decision = decideAccess(pathname, viewer);
  if (decision.allow) return NextResponse.next();

  const url = request.nextUrl.clone();
  const [path, query] = decision.redirectTo.split("?");
  url.pathname = path;
  url.search = query ? `?${query}` : "";
  return NextResponse.redirect(url);
}

/**
 * identify turns a session cookie into a capability.
 *
 * A cookie that exists is not a session that is valid — it can be expired, forged, or signed
 * with a secret this deployment no longer has. So the token is not decoded here: it is handed
 * to the API, which is the only thing that can verify it. Middleware reading the JWT itself
 * would mean two implementations of the same check, and the one here would be the one nobody
 * notices has drifted.
 */
async function identify(request: NextRequest): Promise<Viewer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { cookie: request.headers.get("cookie") ?? "" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return { kind: "anonymous" };
    const account = (await res.json()) as {
      canHost?: boolean;
      isAdmin?: boolean;
    };
    return {
      kind: "account",
      canHost: account.canHost === true,
      isAdmin: account.isAdmin === true,
    };
  } catch {
    // Timed out, or the API is unreachable. Treated as no session, which refuses host routes
    // and leaves every participant route open — the failure mode that keeps a webinar running.
    return { kind: "anonymous" };
  } finally {
    clearTimeout(timer);
  }
}

export const config = {
  /* Only the paths whose answer can be "no".
   *
   * The participant journey is deliberately absent. A registration link and a participant room
   * are open to everyone, so running middleware on them would buy nothing and cost a matcher
   * evaluation on the busiest path in the product — five hundred people arriving at the top of
   * the hour. `/webinars/*` never reaches this file.
   */
  matcher: [
    "/",
    "/host",
    "/host/:path*",
    "/my-webinars",
    "/account",
    /* /admin has to be listed or decideAccess is never consulted for it.
     *
     * It was missed when the admin area was added, and the failure was quiet in exactly the
     * way a matcher omission always is: nothing errors, the page renders its shell, and the
     * gate in access.ts becomes dead code that its own tests still pass against. The API
     * refused every request behind it either way, so this was a UX hole rather than a
     * security one — a non-admin got an error card instead of a redirect. */
    "/admin",
    "/admin/:path*",
  ],
};
