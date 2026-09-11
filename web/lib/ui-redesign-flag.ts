/* Edge-safe UI redesign switch. Middleware + Server Components may import this.
 *
 * Resolution order (first wins):
 *   1. Query  ?ui=new | ?ui=classic  (also sets cookie via middleware)
 *   2. Cookie webcast_ui=new|classic
 *   3. Env    NEXT_PUBLIC_UI_REDESIGN=1 → default new, else classic
 *
 * Workers deploy (`npm run deploy`) builds with NEXT_PUBLIC_UI_REDESIGN=1 so
 * logged-out `/` is the marketing homepage. Opt out anytime with ?ui=classic,
 * cookie webcast_ui=classic, or account menu “Use classic UI”.
 * Marketing is always at `/home` (ignores classic cookie / signed-in skip of `/`).
 */

export const UI_COOKIE = "webcast_ui";
export type UiMode = "new" | "classic";

export function envUiRedesignDefault(): boolean {
  return process.env.NEXT_PUBLIC_UI_REDESIGN === "1";
}

/** Parse an explicit mode string from query or cookie. */
export function parseUiMode(raw: string | null | undefined): UiMode | null {
  if (raw === "new" || raw === "1" || raw === "true") return "new";
  if (raw === "classic" || raw === "0" || raw === "false") return "classic";
  return null;
}

export function resolveUiRedesign(input: {
  query?: string | null;
  cookie?: string | null;
}): boolean {
  const fromQuery = parseUiMode(input.query ?? null);
  if (fromQuery) return fromQuery === "new";
  const fromCookie = parseUiMode(input.cookie ?? null);
  if (fromCookie) return fromCookie === "new";
  return envUiRedesignDefault();
}
