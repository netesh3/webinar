"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Room } from "livekit-client";
import { needsJoinTap } from "@/lib/join-tap";
import { VolumeIcon } from "../icons";
import { Button } from "../ui";
import { useRoomUI } from "./context";

/* "Join webinar", over the live room, for an attendee whose sound the browser is holding.
 *
 * The room is already connecting underneath — the join request went out when the page
 * loaded — so this costs nobody any time: the host's video shows through, dimmed, and the
 * tap is what turns the sound on, the moment they are in. Who is asked, and why it has to be
 * a tap at all, is lib/join-tap.ts.
 *
 * StartAudio's "Tap to enable sound" pill (webinar-room.tsx) stays as the fallback. It
 * renders only while the room says playback is blocked, so after this tap it stays hidden —
 * and if a browser still refuses, it is still there to try again.
 */

/* Asked at most once per page. Moving between stage and audience builds a new room, and
 * somebody who already joined must not be told to join again: from then on, the pill. */
let joinedThisPage = false;

export function JoinTap({ room, publisher }: { room: Room; publisher: boolean }) {
  // Decided at mount, from how the tab arrived. A tap after that does not take the screen
  // back: it is the tap this screen exists to collect.
  const [open, setOpen] = useState(
    () =>
      !joinedThisPage &&
      typeof navigator !== "undefined" &&
      needsJoinTap({
        publisher,
        activated: navigator.userActivation?.hasBeenActive,
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints ?? 0,
      }),
  );
  const { topic, startedAt, endedAt, status } = useRoomUI();
  const button = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const hintId = useId();

  // Focus on the button, so Enter or Space joins from a keyboard.
  useEffect(() => {
    if (open) button.current?.focus();
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  // Live by the same test as the header's clock: started, and not over.
  const live = Boolean(startedAt) && status !== "ended" && !endedAt;

  const join = () => {
    /* Inside the click, not after it: this click is the user activation the browser was
     * waiting for. startAudio plays every audio element the room already has and, on iOS,
     * starts the silent element that lets the ones attached later play too. */
    void room.startAudio().catch(() => {});
    joinedThisPage = true;
    setOpen(false);
  };

  return createPortal(
    <div data-join-tap className="room-dark fixed inset-0 z-[80] grid place-items-center p-4">
      {/* Above the poll and survey popups (z-[70]): a poll the host launched before this
          person arrived must not sit on top of the way in. */}
      <div aria-hidden className="absolute inset-0 bg-black/60 backdrop-blur-[3px]" />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        className="relative flex w-full max-w-[360px] flex-col items-center text-center"
      >
        <h1
          id={titleId}
          className="line-clamp-3 text-[20px] leading-snug font-semibold tracking-[-0.01em] text-white"
        >
          {topic}
        </h1>
        {live ? (
          <span className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-onair/15 px-2.5 py-0.5 text-[11.5px] font-semibold text-onair-soft">
            <span className="size-1.5 rounded-full bg-onair animate-pulse" aria-hidden />
            Live now
          </span>
        ) : (
          <span className="mt-2.5 inline-flex items-center rounded-full bg-white/10 px-2.5 py-0.5 text-[11.5px] font-semibold text-white/80">
            Starting soon
          </span>
        )}

        <Button ref={button} size="lg" className="mt-6 w-full max-w-[280px]" onClick={join}>
          <VolumeIcon className="size-[18px]" />
          Join webinar
        </Button>
        <p id={hintId} className="mt-2.5 text-[12.5px] text-white/70">
          Tap to join with sound
        </p>
      </div>
    </div>,
    document.body,
  );
}
