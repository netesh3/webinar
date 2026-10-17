/* Host rules the Worker applies before Next sees a request (see worker.ts).
 *
 * www is redirected to the apex so search engines see one site. Only page
 * requests: /api keeps answering on www, so a session that lives there is not
 * cut off mid-request. The workers.dev hostname stays up (it is a registered
 * OAuth redirect, deploy/SUPABASE.md) but is marked noindex. */

export const CANONICAL_HOST = "webinarliv.com";

/** The apex URL to 301 to, or null when the request should be served as is. */
export function wwwRedirect(url: URL, method: string): string | null {
  if (url.hostname !== `www.${CANONICAL_HOST}`) return null;
  if (method !== "GET" && method !== "HEAD") return null;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  const to = new URL(url.toString());
  to.hostname = CANONICAL_HOST;
  return to.toString();
}

/** True for hostnames that must not be indexed. */
export function noindexHost(hostname: string): boolean {
  return hostname.endsWith(".workers.dev");
}
