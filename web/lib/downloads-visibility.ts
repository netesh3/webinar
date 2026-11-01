/* Whether the Downloads page (/download) is shown: Admin -> Dashboard -> Site settings,
 * read from GET /api/config (AppConfig.downloadsVisible). Hidden by default while the
 * desktop and mobile apps are not ready (1 Nov 2026).
 *
 * Hidden means: /download redirects home for everyone but admins (who see it with a
 * "Hidden from users" notice, to preview it), and every link to it is left out (the site
 * footers, the account menus, the notification prompts' "Get the app", the sitemap).
 * downloads.webinarliv.com is untouched: its root still 302s to /download, which then
 * redirects home, and latest.json and the installers stay where the installed apps'
 * auto-updater looks for them.
 *
 * Turning it on needs no deploy: pages pick it up when /api/config is next fetched, within
 * TTL_CONFIG (five minutes, lib/http.ts). Tested in downloads-visibility.test.mts. */

/** Where /download sends a visitor while it is hidden. */
export const DOWNLOADS_HIDDEN_REDIRECT = "/";

/** The switch, from /api/config. Anything but an explicit true (no config yet, an API that
 *  predates the switch, the API unreachable) is hidden. */
export function downloadsVisible(config: { downloadsVisible?: boolean } | null | undefined): boolean {
  return config?.downloadsVisible === true;
}

/** Whether a link to /download is drawn: the page is visible, and this is not already our own
 *  app (there is nothing to download from in there). */
export function showGetAppLink(opts: { visible: boolean; inOwnApp: boolean }): boolean {
  return opts.visible && !opts.inOwnApp;
}

/** What /download does for this visitor: render it, render it with the admin's "Hidden from
 *  users" notice, or redirect. */
export type DownloadPageAccess = "show" | "admin-preview" | "redirect";

export function downloadPageAccess(visible: boolean, viewer: { isAdmin: boolean } | null): DownloadPageAccess {
  if (visible) return "show";
  return viewer?.isAdmin === true ? "admin-preview" : "redirect";
}
