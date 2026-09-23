/* What a recovered connection has to put back, and why anything has to remember it.
 *
 * The room's recovery ladder (lib/recovery.ts, wired in components/room/webinar-room.tsx)
 * retries by disconnecting and connecting again. That is a NEW LiveKit session, and a new
 * session publishes nothing:
 *
 *   - On the way out, Room.handleDisconnect unpublishes every local track and clears
 *     localParticipant.trackPublications.
 *   - The SDK republishes in handleSignalRestarted — its OWN signal restart — and nowhere
 *     else. A fresh connect() does not go through it.
 *
 * So without this module a presenter recovered by the ladder sits in the room publishing
 * nothing. Their own preview still works, because that renders from the local track rather
 * than from a publication, so there is nothing on their screen to tell them the audience
 * has lost them. It also feeds the failure back on itself: with no track published the
 * transport is idle, and an idle transport drops on this deployment (measured — see the
 * prepareConnection note in webinar-room.tsx), so the recovery drops again and the ladder
 * counts up to its limit while a page reload fixes it instantly.
 *
 * This file is the bookkeeping and the decision. The wiring — room events, publishTrack,
 * publish options — is in webinar-room.tsx with the rest of the room's wiring, and the
 * reason for the split is the same one recovery.ts gives: a real media-path failure cannot
 * be injected from a test harness, so the part worth testing is kept where a test can
 * reach it. Nothing here imports anything, which is what lets republish.test.mts load it.
 */

/* Sources as strings rather than livekit's Track.Source enum, for the no-imports rule
 * above. The values are the enum's own (Track.Source.Camera === "camera"), so the wiring
 * casts back to it without translating. */
export const MICROPHONE = "microphone";
export const CAMERA = "camera";
export const SCREEN_SHARE = "screen_share";
export const SCREEN_SHARE_AUDIO = "screen_share_audio";

/* The order things go back up in.
 *
 * The voice first, because it is what an audience misses most and what a presenter is most
 * likely to be in the middle of using. The share last, because it is the heaviest to
 * negotiate and must not delay the two that matter more — a presenter whose microphone is
 * back and whose slides are a second behind is in a far better position than the reverse.
 *
 * A source absent from this list is never restored. That is deliberate rather than an
 * oversight: restoring something this file has no stated opinion about is how a surprise
 * gets published on somebody's behalf.
 */
const RESTORE_ORDER: readonly string[] = [
  MICROPHONE,
  CAMERA,
  SCREEN_SHARE,
  SCREEN_SHARE_AUDIO,
];

/** One thing to put back. */
export type Restorable<T> = { source: string; track: T };

export type PublishLedger<T> = {
  /** Note a publication. */
  published(source: string, track: T): void;
  /** Note an unpublication. Ignored while a drop is in progress — see `dropping`. */
  unpublished(source: string): void;
  /** A drop has begun: stop reading unpublications as the presenter's intent. */
  dropping(): void;
  /** Connected and restored: unpublications mean what they say again. */
  settled(): void;
  /** True between `dropping` and `settled`. */
  isDropping(): boolean;
  /**
   * What to put back, in the order to put it back.
   *
   * `isCapturing` answers whether the capture behind a track is still running, and is
   * passed in rather than read here so this module needs no MediaStreamTrack.
   */
  restorable(isCapturing: (track: T) => boolean): Restorable<T>[];
};

/**
 * A record of what this browser is publishing, kept so a reconnect can put it back.
 *
 * Keyed by source, not by track. A device switch republishes on the same source and must
 * REPLACE the old entry rather than accumulate next to it — otherwise recovery would put
 * back the camera the presenter switched away from.
 *
 * Mute state is deliberately not recorded. It rides along on the track: publishTrack
 * preserves LocalTrack.isMuted, so a muted microphone comes back muted. A camera the
 * presenter turned off does not come back at all, and that is also correct rather than
 * lucky — muting a camera stops its capture to put the indicator light out, which leaves
 * nothing to republish, which is exactly what "off" should mean.
 */
export function publishLedger<T>(): PublishLedger<T> {
  const bySource = new Map<string, T>();

  /* Why unpublications have to be ignored during a drop, and cannot simply be trusted.
   *
   * LiveKit's teardown unpublishes every local track on its way out, one event per track,
   * and it does so while room.state is still Connected — the state flips to Disconnected
   * afterwards, so the state cannot be used to tell the two apart. Read literally, a drop
   * therefore looks exactly like the presenter turning everything off by hand, and the
   * ledger would be empty by the time anything wanted to read it.
   *
   * The signal is instead the SDK's own reconnection events, which fire BEFORE the
   * teardown. Between them and a restore, unpublications are the drop talking, not the
   * presenter.
   *
   * The failure mode if this flag is ever wrong in the pessimistic direction — a teardown
   * with no reconnection event in front of it — is that the ledger empties and nothing is
   * restored, which is the behaviour this file replaces. It cannot cause something to be
   * published that the presenter had stopped, which is the failure that would matter.
   */
  let dropping = false;

  return {
    published(source, track) {
      bySource.set(source, track);
    },

    unpublished(source) {
      if (dropping) return;
      bySource.delete(source);
    },

    dropping() {
      dropping = true;
    },

    settled() {
      dropping = false;
    },

    isDropping() {
      return dropping;
    },

    restorable(isCapturing) {
      const back: Restorable<T>[] = [];
      for (const source of RESTORE_ORDER) {
        const track = bySource.get(source);
        if (track === undefined) continue;
        // A capture that has ended cannot be republished, and asking would throw. This is
        // the muted camera, the unplugged webcam and the share the presenter stopped from
        // the browser's own bar.
        if (!isCapturing(track)) continue;
        back.push({ source, track });
      }
      return back;
    },
  };
}
