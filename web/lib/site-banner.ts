/* Whether the site-wide maintenance banner shows (components/site-banner.tsx). Pure, so the
 * rules are tested (site-banner.test.mts): on, a message, not an admin, and not dismissed in
 * this browser session for this same message (a new message shows again). */
export type BannerState = { enabled: boolean; message: string; updatedAt?: string };

/** The sessionStorage key a dismissal is kept under. */
export const BANNER_DISMISS_KEY = "site-banner-dismissed";

/** What a dismissal remembers: the banner it dismissed, so a changed banner shows again. */
export function bannerId(b: BannerState): string {
  return `${b.updatedAt ?? ""}|${b.message}`;
}

export function bannerVisible(b: BannerState | null, opts: { isAdmin: boolean; dismissed: string | null }): boolean {
  if (!b || !b.enabled || !b.message.trim()) return false;
  if (opts.isAdmin) return false;
  return opts.dismissed !== bannerId(b);
}
