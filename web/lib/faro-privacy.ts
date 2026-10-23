/* What Grafana Faro (lib/faro-init.ts) may send about a page, and what it may not.
 *
 * The URLs in this app carry credentials: ?k= join keys on webinar links, ?t= tokens on
 * recorder and unsubscribe links, ?token= on verify and reset links. None of them may reach
 * Grafana Cloud, so every item Faro is about to send goes through scrubItem() first (its
 * beforeSend hook): query strings and fragments are cut from every URL in it, and anything
 * that looks like an email address or a JWT is replaced. No imports, so the unit test
 * (faro-privacy.test.mts) runs it as is.
 */

/** A URL, absolute or root-relative, without its query string and fragment. */
export function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

// An absolute URL, then a query or fragment, up to the next space or quote; and the same for
// a root-relative path at the start or after a space, bracket, quote or `=`. What is kept is
// the part before the first ? or #. (No lookbehind: Safari before 16.4 cannot parse one.)
const ABSOLUTE_WITH_QUERY = /([a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>`]*)[?#][^\s"'<>`]*/gi;
const RELATIVE_WITH_QUERY = /(^|[\s("'`=])(\/[^\s?#"'<>`]*)[?#][^\s"'<>`]*/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// A bare credential parameter outside a URL ("k=abc123" in an error message).
const CREDENTIAL_PARAM = /\b(k|t|token|key|join_?key|access_token|code)=[^\s&"'<>`]+/gi;

/** Free text (an error message, an attribute) with credentials taken out. */
export function scrubText(text: string): string {
  return text
    .replace(ABSOLUTE_WITH_QUERY, "$1")
    .replace(RELATIVE_WITH_QUERY, "$1$2")
    .replace(JWT, "[token]")
    .replace(EMAIL, "[email]")
    .replace(CREDENTIAL_PARAM, "$1=[redacted]");
}

const MAX_DEPTH = 12;

/** A copy of any Faro payload or meta with every string in it scrubbed. Page URLs (any
 *  `url` key) lose their query and fragment outright. */
export function scrubValue<T>(value: T, key = "", depth = 0): T {
  if (typeof value === "string") {
    return (key === "url" || key === "href" ? stripQuery(value) : scrubText(value)) as T;
  }
  if (value === null || typeof value !== "object" || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(v, key, depth + 1)) as T;
  }
  // Errors kept for beforeSend (preserveOriginalError) and the like: not plain data.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = scrubValue(v, k, depth + 1);
  }
  return out as T;
}

/** Faro's beforeSend: the item with its payload and meta scrubbed. The user meta is dropped
 *  entirely: nothing here sets one, and nothing that a library might set is wanted. */
export function scrubItem<I extends { payload: unknown; meta: object }>(item: I): I {
  const meta = scrubValue({ ...item.meta } as Record<string, unknown>);
  delete meta.user;
  return { ...item, payload: scrubValue(item.payload), meta } as I;
}
