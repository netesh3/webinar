/* The pure half of lib/own-share.ts, split out so its tests run under plain Node without
 * React or livekit-client (the same split as pip-dismiss.ts). */

export type ShareSurface = "browser" | "window" | "monitor";

/** The surface a capture track is of, or null when the browser does not say. */
export function shareSurface(track: MediaStreamTrack | undefined | null): ShareSurface | null {
  if (!track || typeof track.getSettings !== "function") return null;
  const surface = (track.getSettings() as { displaySurface?: string }).displaySurface;
  return surface === "browser" || surface === "window" || surface === "monitor" ? surface : null;
}

/** 0:07, 2:14, 1:03:09 — the presenter's elapsed time. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** Whether a share of this surface gets the presenter view (preview, floating controls).
 *  A tab does not: Chrome already takes you to it and gives it its own controls. Unknown
 *  does not either: guessing wrong about "monitor" would play the screen back to itself. */
export function wantsPresenterView(surface: ShareSurface | null): surface is "window" | "monitor" {
  return surface === "window" || surface === "monitor";
}
