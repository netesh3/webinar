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
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
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
