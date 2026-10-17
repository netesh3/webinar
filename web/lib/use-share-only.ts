"use client";

import { useTracks } from "@livekit/components-react";
import {
  Track,
  type RemoteTrackPublication,
  type TrackPublication,
} from "livekit-client";
import { useEffect, useRef } from "react";
import { wantsSource, type SubscriptionPlan } from "./share-only";

/* The LiveKit half of "Show only the shared video to the audience" — the decision
 * itself is lib/share-only.ts. Shared by the audience's stage and the recorder
 * template, which is also what the CDN broadcast is composited from, so a
 * recording and the broadcast download and draw what the audience in the room does.
 */

function remote(publication: TrackPublication | undefined): RemoteTrackPublication | null {
  const p = publication as RemoteTrackPublication | undefined;
  return p && typeof p.setSubscribed === "function" ? p : null;
}

/** Whether a screen share is on the stage, subscribed to or not. Read from the
 *  publications rather than from what has arrived, so turning cameras off cannot
 *  feed back into whether the share-only view applies. */
export function useStageShareActive(): boolean {
  const shares = useTracks([Track.Source.ScreenShare], { onlySubscribed: false });
  return shares.some((ref) => !!ref.publication && !ref.publication.isMuted);
}

/** Holds this browser's stage camera and microphone subscriptions to `plan`.
 *
 *  Only ever undoes its own work: a track is resubscribed only if this hook is
 *  the one that unsubscribed it, so a room that subscribes selectively for its own
 *  reasons is left alone. Screen share video and audio are never touched. Leaving
 *  (unmount) puts back everything it took away. */
export function useSubscriptionPlan(plan: SubscriptionPlan): void {
  const refs = useTracks([Track.Source.Camera, Track.Source.Microphone], {
    onlySubscribed: false,
  });
  const off = useRef(new Set<RemoteTrackPublication>());

  // A signature, so the effect runs on a real change rather than on every
  // audio-level re-render. isDesired is in it so a track that arrives (or is
  // auto-subscribed) while the plan is in force is caught.
  const signature = refs
    .map(
      (ref) =>
        `${ref.participant.identity}:${ref.source}:${ref.publication?.trackSid ?? ""}:${
          remote(ref.publication)?.isDesired ? 1 : 0
        }`,
    )
    .join(",");

  useEffect(() => {
    const present = new Set<RemoteTrackPublication>();
    for (const ref of refs) {
      if (ref.participant.isLocal) continue;
      const publication = remote(ref.publication);
      if (!publication) continue;
      present.add(publication);
      if (wantsSource(ref.source, plan)) {
        if (off.current.delete(publication)) publication.setSubscribed(true);
      } else if (!off.current.has(publication) && publication.isDesired) {
        publication.setSubscribed(false);
        off.current.add(publication);
      }
    }
    // Gone from the room: nothing to put back.
    for (const publication of off.current) {
      if (!present.has(publication)) off.current.delete(publication);
    }
    // `signature` stands for `refs`; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, plan.cameras, plan.microphones]);

  useEffect(() => {
    const taken = off.current;
    return () => {
      for (const publication of taken) publication.setSubscribed(true);
      taken.clear();
    };
  }, []);
}
