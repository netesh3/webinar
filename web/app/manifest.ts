import type { MetadataRoute } from "next";

/* The web app manifest, and it exists for one capability.
 *
 * Chrome refuses to pop a Picture-in-Picture window without a user gesture — measured, not
 * assumed; see lib/pip.ts. The single exception is an INSTALLED app: for one of those, Chrome
 * fires the MediaSession "enterpictureinpicture" action when the user switches away, and that
 * handler runs with the activation requestWindow() needs. So "pop out automatically when I go
 * to another tab" is reachable only on the other side of being installable, and nothing else
 * in the app needed a manifest before now.
 *
 * `display: standalone` is the part that makes the install prompt appear at all — a manifest
 * without it describes a bookmark. Everyone who does not install is unaffected: they keep the
 * Pop out button, and the automatic half simply never fires for them.
 *
 * Deliberately minimal. No screenshots, no shortcuts, no share_target: those change how the app
 * is presented in stores and OS menus, which is a product decision nobody has made, and a
 * manifest that quietly claims them is a manifest that has grown past its reason for existing.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Webinar Liv",
    short_name: "Webinar Liv",
    description:
      "Host and attend live webinars — video, chat, Q&A, polls and recordings in the browser.",
    start_url: "/",
    display: "standalone",
    /* Matched to the app's own surfaces rather than to white: an installed window paints these
     * before any of our CSS loads, and a white flash in front of a dark room is the one frame
     * everybody notices. `theme_color` is the brand blue the top bar already uses. */
    background_color: "#0d0d11",
    theme_color: "#2563eb",
    orientation: "any",
    icons: [
      // The existing app icons, already served by Next's own metadata routes, so this adds a
      // manifest rather than another copy of the artwork.
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/apple-icon.png", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
