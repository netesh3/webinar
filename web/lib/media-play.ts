/* play() and Room.startAudio() without an unhandled rejection (31 Oct 2026).
 *
 * Faro had an uncaught "NotAllowedError: The request is not allowed by the user agent or
 * the platform in the current context" from an iPhone in a WebRTC room. That is WebKit
 * refusing to play with sound outside a tap, and nothing had caught it. The likeliest
 * source is livekit-client itself: on iOS, Room.startAudio() adds a silent <audio> plus a
 * visibilitychange listener that calls `this.startAudio()` again, un-awaited, every time
 * the page comes back to the foreground. Coming back is not a tap, so the play() inside
 * is refused, startAudio re-throws, and nobody is listening. Its AudioStreamAcquired
 * handler and the StartAudio pill's click (@livekit/components-core) do the same.
 *
 * A refusal is not an error here: LiveKit has already flipped room.canPlaybackAudio to
 * false, which is what shows the "Tap to enable sound" pill (StartAudio in webinar-room.tsx),
 * and the next tap tries again. AbortError is a play() overtaken by a pause or a new
 * source. Anything else is a real failure and is reported.
 *
 * Only lib/observability.ts (itself import-free) is imported, so lib/media-play.test.mts
 * can load this; the tests pass their own reporter. */

import { reportError } from "./observability.ts";

const reportPlay = (err: unknown) => reportError("media_play_failed", err);
const reportStartAudio = (err: unknown) => reportError("room_start_audio_failed", err);

/** What a play() came to. Never "throws": a failure that is not the browser's policy
 *  is handed to the reporter and comes back as "failed". */
export type PlayOutcome = "played" | "refused" | "aborted" | "failed";

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && typeof (err as { name?: unknown }).name === "string"
    ? (err as { name: string }).name
    : "";
}

/** The browser declining (NotAllowedError: autoplay policy, no gesture) or a play()
 *  overtaken by a pause or reload (AbortError). Neither is worth an error report. */
export function isPlaybackRefusal(err: unknown): boolean {
  const name = errorName(err);
  return name === "NotAllowedError" || name === "AbortError";
}

/** media.play(), settled. Use instead of `void media.play()`, whose refusal is an
 *  unhandled rejection. */
export async function playMedia(
  media: { play(): Promise<void> | void } | null | undefined,
  report: (err: unknown) => void = reportPlay,
): Promise<PlayOutcome> {
  if (!media) return "failed";
  try {
    await media.play();
    return "played";
  } catch (err) {
    const name = errorName(err);
    if (name === "NotAllowedError") return "refused";
    if (name === "AbortError") return "aborted";
    report(err);
    return "failed";
  }
}

type StartsAudio = { startAudio: () => Promise<void> };

const guarded = new WeakSet<object>();

/**
 * Makes `room.startAudio()` resolve whatever happens, for every caller: ours, the
 * StartAudio pill's, and livekit-client's own un-awaited calls (it looks the method up on
 * the instance each time). Call it on a new Room, before connect.
 *
 * A refusal resolves quietly: the room has already set canPlaybackAudio false and emitted
 * AudioPlaybackStatusChanged, so callers read the outcome from room.canPlaybackAudio.
 * Anything else goes to `report`, and resolves too.
 */
export function guardStartAudio<R extends StartsAudio>(
  room: R,
  report: (err: unknown) => void = reportStartAudio,
): R {
  if (guarded.has(room)) return room;
  guarded.add(room);
  const original = room.startAudio.bind(room);
  room.startAudio = async () => {
    try {
      await original();
    } catch (err) {
      if (!isPlaybackRefusal(err)) report(err);
    }
  };
  return room;
}
