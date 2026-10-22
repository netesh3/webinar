/* Captions on replays: the original session's own captions as a WebVTT <track> on the player
 * (api/internal/api/recording_captions.go). The pure half: the file's address and switching
 * the track on and off. The hook that loads it is lib/use-caption-track.ts.
 *
 * The file is fetched and handed to the <track> as a blob: URL rather than pointed at the API
 * directly, because the API may be on another origin and a cross-origin <track> needs the
 * <video> itself to be crossorigin — which would make every recording file and HLS segment
 * need CORS too. A blob is same-origin, works with hls.js (it only manages the tracks it made)
 * and with Safari's native HLS, and the native track keeps the cues in step with playback,
 * seeking and the simulive's shared clock with nothing else to schedule. */

/** A captions file's address with its query: empty values are left out. */
export function captionsURL(base: string, params: Record<string, string | undefined> = {}): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join("&");
  return qs ? `${base}?${qs}` : base;
}

/** The mode a captions track is put in: shown, or loaded but hidden. */
export function captionsMode(on: boolean): TextTrackMode {
  return on ? "showing" : "hidden";
}

/** Switches the video's captions tracks on or off. */
export function showCaptions(video: HTMLVideoElement | null, on: boolean): void {
  if (!video) return;
  const tracks = video.textTracks;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (t.kind === "captions" && t.label === CAPTIONS_LABEL) t.mode = captionsMode(on);
  }
}

/** The label on our track, so only ours is switched (hls.js may add its own). */
export const CAPTIONS_LABEL = "Captions";
