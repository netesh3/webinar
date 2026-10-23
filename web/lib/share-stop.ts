/* Ending a screen share so the browser actually lets go of it.
 *
 * A publisher's room runs with stopLocalTrackOnUnpublish off (lib/media.ts), so a camera
 * toggled off hands the same track back without a second permission prompt. LiveKit's
 * setScreenShareEnabled(false) honours that flag too: it unpublishes the share's video and
 * tab audio and stops neither. The audience saw the share end, but the capture kept
 * running — Chrome's "Sharing this tab — Stop sharing / Hide" bar stayed up, and dismissing
 * it did nothing, because the page still held live tracks. A capture only ends when EVERY
 * track from it is stopped, so the tab-audio track alone is enough to keep the bar there.
 *
 * Hence stopping a share here: unpublish each share track with stop-on-unpublish forced on,
 * then detach and stop each one again regardless of how the unpublish went.
 *
 * No imports, so `node --experimental-strip-types` can test it directly. The source strings
 * are Track.Source's own values (the same identity lib/republish.ts relies on).
 */

export const SCREEN_SHARE = "screen_share";
export const SCREEN_SHARE_AUDIO = "screen_share_audio";

export function isShareSource(source: string | undefined): boolean {
  return source === SCREEN_SHARE || source === SCREEN_SHARE_AUDIO;
}

/** What is needed of a LocalTrack: stop, and optionally detach from <video>/<audio>. */
export interface StoppableTrack {
  stop(): void;
  /** LiveKit's detach clears srcObject on every element the track was attached to. */
  detach?: () => unknown;
  mediaStreamTrack?: { readyState?: string; stop(): void };
}

export interface SharePublication<T extends StoppableTrack> {
  source: string;
  track?: T;
}

/**
 * Every distinct track a share holds: the publications on a share source (video and tab
 * audio), plus any extra tracks the caller knows about — tracks a switch captured but has
 * not published yet, say. Order kept, duplicates and gaps dropped.
 */
export function shareTracksToStop<T extends StoppableTrack>(
  publications: Iterable<SharePublication<T>>,
  extra: Iterable<T | undefined> = [],
): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  const add = (t: T | undefined) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const pub of publications) if (isShareSource(pub.source)) add(pub.track);
  for (const t of extra) add(t);
  return out;
}

/** Detaches and stops each track, and its underlying MediaStreamTrack. Never throws. */
export function releaseTracks(tracks: Iterable<StoppableTrack>): void {
  for (const track of tracks) {
    try {
      track.detach?.();
    } catch {
      // An element already gone; stopping is what matters.
    }
    try {
      track.stop();
    } catch {
      // Already stopped.
    }
    try {
      // LiveKit's stop() does this too; belt and braces for a track whose wrapper is gone.
      track.mediaStreamTrack?.stop();
    } catch {
      // Already stopped.
    }
  }
}

/** The part of a LocalParticipant that stopping a share needs. */
export interface ShareParticipant<T extends StoppableTrack> {
  trackPublications: { values(): Iterable<SharePublication<T>> };
  unpublishTrack(track: T, stopOnUnpublish?: boolean): Promise<unknown>;
}

/**
 * Stops the local screen share: unpublishes its video and audio, then stops every track,
 * including `extra` ones. Use instead of setScreenShareEnabled(false), which leaves the
 * capture running (see the top of this file). Not for a shared video file — lib/file-share.ts
 * owns that teardown.
 */
export async function stopScreenShare<T extends StoppableTrack>(
  participant: ShareParticipant<T>,
  extra: Iterable<T | undefined> = [],
): Promise<void> {
  const tracks = shareTracksToStop(participant.trackPublications.values(), extra);
  const published = new Set<T>();
  for (const pub of participant.trackPublications.values()) {
    if (isShareSource(pub.source) && pub.track) published.add(pub.track);
  }
  try {
    await Promise.allSettled(
      tracks.filter((t) => published.has(t)).map((t) => participant.unpublishTrack(t, true)),
    );
  } finally {
    releaseTracks(tracks);
  }
}

/**
 * Whether an unpublished share was ended by the browser rather than by us — Chrome's own
 * "Stop sharing", or the shared window closing. Its video track is then already "ended";
 * LiveKit unpublishes that track itself but leaves the tab audio published and capturing,
 * which keeps the capture (and the bar) alive. A teardown for a reconnect unpublishes live
 * tracks, so it never matches here and the share can be restored afterwards.
 */
export function browserEndedShare(source: string, track: StoppableTrack | undefined): boolean {
  return source === SCREEN_SHARE && track?.mediaStreamTrack?.readyState === "ended";
}
