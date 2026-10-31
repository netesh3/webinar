import type { MetadataRoute } from "next";

/* The web app manifest, served by Next at /manifest.webmanifest (application/manifest+json).
 *
 * Two capabilities sit on the other side of being installable:
 *
 *  - Automatic Picture-in-Picture. Chrome refuses to pop a PiP window without a user gesture —
 *    measured, not assumed; see lib/pip.ts — except in an INSTALLED app, where the MediaSession
 *    "enterpictureinpicture" action fires with the activation requestWindow() needs.
 *  - Web Push on iPhone and iPad. iOS 16.4+ delivers push only to a site added to the Home
 *    Screen, so "tell me when it starts" there needs this file (and public/sw.js) first.
 *
 * `display: standalone` is what makes the install prompt appear at all — a manifest without it
 * describes a bookmark. Everyone who does not install is unaffected.
 *
 * Deliberately minimal still. No screenshots, no shortcuts, no share_target: those change how
 * the app is presented in stores and OS menus, which is a product decision nobody has made.
 *
 * Installed copies must not capture links (31 Oct 2026). The site stopped offering the PWA
 * (components/pwa.tsx), but old installs remain, and Chrome's link capturing can move a
 * navigation (a desktop app's Google sign-in, say) into the PWA window and send it again. A
 * Google callback sent twice failed the second time until api/auth_google_replay.go; that
 * incident had another sender, but an installed copy should not be one. So:
 *
 *  - `handle_links: "not-preferred"`: a link to the site opens in the browser tab it was
 *    clicked in, not in an installed app window. Not in Next's Manifest type yet, hence the
 *    intersection; Next serialises the object as it is.
 *  - `launch_handler: navigate-new`: when the app IS launched with a URL, it gets a window of
 *    its own rather than taking over (focus-existing would drop the navigation, so a captured
 *    /api/auth/google/callback would never run at all).
 *
 * Neither can carve /api/auth/* or /auth/* out of an install: scope is a path prefix that can
 * only include, never exclude, and narrowing it from "/" would change what old installs are.
 * Hence the callback copes with repeats instead of relying on this.
 */
export default function manifest(): MetadataRoute.Manifest & { handle_links: "preferred" | "not-preferred" | "auto" } {
  return {
    handle_links: "not-preferred",
    launch_handler: { client_mode: "navigate-new" },
    id: "/",
    name: "Webinar Liv",
    short_name: "Webinar Liv",
    description:
      "Host and attend live webinars — video, chat, Q&A, polls and recordings in the browser.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    /* From the design tokens (app/globals.css): --color-page behind the first paint, since the
     * start URL is the light portal, and --color-brand for the title bar. */
    background_color: "#f7f9fa",
    theme_color: "#0b5cff",
    orientation: "any",
    icons: [
      // public/icons, drawn by scripts/pwa-icons.mjs.
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
