"use client";

import { useLocalParticipant } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCompact } from "@/lib/compact";
import { ChevronDownIcon, ScreenShareIcon, StopIcon } from "../icons";
import { useRoomUI } from "./context";

/* The persistent "you're sharing" strip.
 *
 * The control-bar Share button already toggles, and the browser draws its own
 * chrome at the top of the shared window — and both of those are easy to lose
 * behind other windows. This stays in the room, with Stop as the primary action,
 * so ending a share is one click even when the bar is covered.
 *
 * Compact: a one-line strip. No thumbnail. A phone has no room for a floating
 * preview of a share the OS is already showing, and a large card would cover the
 * speaker.
 *
 * Pause, annotation, and "optimize for video" are not here. Pause would have to
 * mute the published track without dropping it, which LiveKit can do, but a frozen
 * last frame is not a pause the audience can tell from a stall — so we do not
 * offer it. Annotation we do not have. Flipping contentHint to motion would
 * rewrite the calibrated share encode in lib/media.ts, which this strip is not
 * allowed to casually do.
 */

export function ShareStopBar() {
  const compact = useCompact();
  const { localParticipant, isScreenShareEnabled } = useLocalParticipant();
  const { fileShare, previewChrome } = useRoomUI();
  const [collapsed, setCollapsed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // A shared file has its own playback bar. This one is for a live display surface.
  const sharing = isScreenShareEnabled && !fileShare.active && !previewChrome;

  const pub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
  const track = pub?.videoTrack;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track || compact || collapsed) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, compact, collapsed]);

  const stop = useCallback(() => {
    void localParticipant.setScreenShareEnabled(false);
  }, [localParticipant]);

  if (!sharing) return null;

  if (compact) {
    return (
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-2 pt-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <div className="pointer-events-auto flex min-h-11 w-full max-w-lg items-center gap-2 rounded-xl bg-ok px-2 py-1 text-ink shadow-xl">
          <p className="min-w-0 flex-1 truncate px-1.5 text-[12.5px] font-semibold">
            You&apos;re sharing your screen
          </p>
          <button
            type="button"
            onClick={stop}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-live px-3 text-[12.5px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <StopIcon className="size-3.5" />
            Stop sharing
          </button>
        </div>
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3">
        <div className="pointer-events-auto flex items-center gap-1 rounded-xl bg-ok p-1 shadow-xl">
          <button
            type="button"
            onClick={stop}
            className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-live px-3 text-[12.5px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <StopIcon className="size-3.5" />
            Stop sharing
          </button>
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sharing controls"
            className="grid size-10 place-items-center rounded-lg text-ink/80 outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-ink/40"
          >
            <ChevronDownIcon className="size-4 rotate-180" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-xl items-stretch gap-2 rounded-xl bg-ok p-1.5 text-ink shadow-xl">
        {track ? (
          <div className="relative w-36 shrink-0 overflow-hidden rounded-lg bg-ink/20">
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              className="block h-20 w-full object-contain"
            />
          </div>
        ) : (
          <div className="grid w-12 shrink-0 place-items-center">
            <ScreenShareIcon className="size-5" />
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col justify-center px-1">
          <p className="text-[13px] font-semibold">You&apos;re sharing your screen</p>
          <p className="text-[11.5px] text-ink/70">Everyone in the webinar can see it.</p>
        </div>
        <button
          type="button"
          onClick={stop}
          className="inline-flex h-10 shrink-0 self-center items-center gap-1.5 rounded-lg bg-live px-3 text-[12.5px] font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-white/70"
        >
          <StopIcon className="size-3.5" />
          Stop sharing
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse sharing controls"
          className="grid size-10 shrink-0 self-center place-items-center rounded-lg text-ink/80 outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-ink/40"
        >
          <ChevronDownIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
