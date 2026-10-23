/* A simulive plays like a live broadcast: one shared clock for everybody (the session's start,
 * lib/simulive-replay.ts sharedPositionMs), so the player offers nothing that moves an
 * attendee off it — no play/pause, no scrubber, no time or duration, no speed, no skip.
 *
 * The chrome never offers those, but a browser still can: arrow keys on a focused video, the
 * media keys, the OS media card (Chrome's global controls, the macOS Now Playing widget, the
 * Android notification), a picture-in-picture window, devtools, a throttled background tab.
 * Rather than chase every one, the player checks itself against the shared clock and puts
 * itself back (simuliveCorrection), the same way a live stream has nowhere else to be.
 *
 * Pure so node can test it — simulive-clock.test.mts, run by `make test-web`. */

/** How far the player may be from the shared position before it is put back, in seconds.
 *  Enough to absorb a start-up second and a buffer hiccup; less than any deliberate seek. */
export const DRIFT_TOLERANCE_SEC = 2;

export type ClockReading = {
  /** The element's currentTime. */
  positionSec: number;
  /** Where everybody is (sharedPositionMs / 1000), or null before the session starts. */
  sharedSec: number | null;
  /** The media's duration; NaN or Infinity until known. */
  durationSec: number;
  paused: boolean;
  ended: boolean;
  /** play() was refused (autoplay policy, even muted): resuming waits for a tap. */
  blocked: boolean;
};

export type Correction = {
  /** Seek here, or null to leave the position alone. */
  seekTo: number | null;
  /** Call play(). */
  resume: boolean;
};

/** What the player must do to be back on the shared clock. */
export function simuliveCorrection(r: ClockReading, toleranceSec = DRIFT_TOLERANCE_SEC): Correction {
  if (r.sharedSec == null || !Number.isFinite(r.sharedSec) || r.sharedSec < 0) {
    return { seekTo: null, resume: false };
  }
  const known = Number.isFinite(r.durationSec) && r.durationSec > 0;
  // Past the end of the recording everybody is at the end: nothing left to play.
  if (known && r.sharedSec >= r.durationSec - 0.5) {
    const last = Math.max(0, r.durationSec - 0.5);
    const seekTo = !r.ended && Math.abs(r.positionSec - last) > toleranceSec ? last : null;
    return { seekTo, resume: false };
  }
  const target = known ? Math.min(r.sharedSec, r.durationSec - 0.5) : r.sharedSec;
  const drift = r.positionSec - target;
  return {
    seekTo: Math.abs(drift) > toleranceSec ? target : null,
    resume: (r.paused || r.ended) && !r.blocked,
  };
}

export type PlayerKind = "vod" | "live" | "simulive";

export type PlayerControls = {
  playPause: boolean;
  seekBar: boolean;
  time: boolean;
  playbackRate: boolean;
  skip: boolean;
  volume: boolean;
  captions: boolean;
  fullscreen: boolean;
  liveBadge: boolean;
};

/** Which controls a player shows. A recording replay (components/video-player.tsx) is a
 *  file and keeps every control; a live stage and a simulive are broadcasts and keep only
 *  sound, captions and fullscreen. Every kind has a fullscreen button: our container via the
 *  Fullscreen API, or where a browser has none (an iPhone) the native player for a live
 *  stage — nowhere to seek on a live stream — and CSS pseudo-fullscreen for a simulive,
 *  never the native player and its scrubber (lib/fullscreen.ts). */
export function playerControls(kind: PlayerKind): PlayerControls {
  const file = kind === "vod";
  return {
    playPause: file,
    seekBar: file,
    time: file,
    playbackRate: file,
    skip: file,
    volume: true,
    captions: true,
    fullscreen: true,
    liveBadge: !file,
  };
}

/** Whether the <video> itself is in the browser's own fullscreen player, with native controls
 *  and a scrubber: the iOS player (a pinch out on the picture opens it, no button needed;
 *  video.webkitDisplayingFullscreen) or the video element as the document's fullscreen
 *  element (Android Chrome's rotate-to-fullscreen). A simulive leaves it for pseudo-fullscreen.
 *  Our container being the fullscreen element is fine: that is our chrome, not theirs. */
export function videoInNativeFullscreen(s: {
  fullscreenElement: unknown;
  video: unknown;
  webkitDisplayingFullscreen?: boolean;
}): boolean {
  if (s.video == null) return false;
  return s.fullscreenElement === s.video || Boolean(s.webkitDisplayingFullscreen);
}

/** Keys a browser maps to seeking or pausing a media element; a simulive swallows them. */
export const SIMULIVE_BLOCKED_KEYS: ReadonlySet<string> = new Set([
  " ",
  "k",
  "K",
  "j",
  "J",
  "l",
  "L",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "MediaPlayPause",
  "MediaPause",
  "MediaStop",
  "MediaTrackNext",
  "MediaTrackPrevious",
  "MediaFastForward",
  "MediaRewind",
]);
