"use client";

import { VideoTrack, useTracks } from "@livekit/components-react";
import { Track } from "livekit-client";
import { useMemo } from "react";
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from "../icons";
import { useActiveSpeaker } from "./active-speaker";

/* What goes inside the popped-out window.
 *
 * One video, a name, and the two controls somebody in another tab cannot otherwise reach. Not
 * the whole stage: the window is 400px wide by default, and a grid of eight tiles at that size
 * is eight thumbnails of nobody in particular.
 *
 * WHICH video, in priority order, and the order is the point:
 *
 *   1. a screen share, if there is one
 *   2. whoever is speaking
 *   3. whoever is first
 *
 * The share wins because of why people pop out. Somebody who puts a webinar in a corner while
 * they work is following the slides, and giving them a talking head instead of the slides is
 * giving them the half they did not need. When nobody is sharing there is no such choice to get
 * wrong, and the speaker is the only sensible answer.
 *
 * Deliberately close to Stage's own focus rule (pinned ?? screenShare ?? first) without
 * reusing it: Stage resolves a pin, and a pin is a thing you set while looking at the stage,
 * which is not what this window is for.
 */

export function PipStage({
  micEnabled,
  cameraEnabled,
  onMic,
  onCamera,
  onBackToTab,
  canSpeak,
  canShareCamera,
}: {
  micEnabled: boolean;
  cameraEnabled: boolean;
  onMic: () => void;
  onCamera: () => void;
  onBackToTab: () => void;
  /** Handlers come from the control bar rather than being rebuilt here — see the note in
   *  control-bar.tsx. A muted-by-host attendee must get the same refusal in both places. */
  canSpeak: boolean;
  canShareCamera: boolean;
}) {
  const tracks = useTracks([Track.Source.ScreenShare, Track.Source.Camera], {
    onlySubscribed: true,
  });
  const speaking = useActiveSpeaker();

  const shown = useMemo(() => {
    const share = tracks.find((t) => t.source === Track.Source.ScreenShare);
    if (share) return share;
    const talker = tracks.find(
      (t) => t.source === Track.Source.Camera && t.participant.identity === speaking,
    );
    return talker ?? tracks[0];
  }, [tracks, speaking]);

  const isShare = shown?.source === Track.Source.ScreenShare;
  const label = shown
    ? isShare
      ? `${shown.participant.name || "Someone"} is sharing`
      : shown.participant.name || "Someone"
    : null;

  return (
    <div className="flex h-dvh w-full flex-col bg-black">
      <div className="relative min-h-0 flex-1">
        {shown ? (
          <VideoTrack
            trackRef={shown}
            /* object-contain, never cover. A shared screen cropped to fill a 16:9 window
               loses whichever edge the slide's text was on, and the letterbox is the honest
               shape of what is being sent. */
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="grid h-full w-full place-items-center px-4 text-center">
            <p className="text-[12px] leading-relaxed text-white/60">
              Nobody has their camera on yet. This window will show them when they do.
            </p>
          </div>
        )}

        {label && (
          /* Over the video rather than under it, because the window is short and a bar
             stacked above the controls would leave the picture a letterbox slit. */
          <div className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-b from-black/70 to-transparent px-2.5 pt-1.5 pb-5">
            <p className="truncate text-[11.5px] font-medium text-white/90">{label}</p>
          </div>
        )}
      </div>

      {/* The controls, and the reason they are here at all.
          A panelist in another tab who is asked a question has to find the webinar before they
          can answer, and "sorry, I was looking for the tab" is the sound of this feature
          failing. Only the ones that apply: an attendee who cannot publish gets the one button
          that takes them back. */}
      <div className="flex shrink-0 items-center gap-1.5 border-t border-white/10 bg-black px-2 py-1.5">
        {canSpeak && (
          <PipButton
            onClick={onMic}
            danger={!micEnabled}
            label={micEnabled ? "Mute" : "Unmute"}
          >
            {micEnabled ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
          </PipButton>
        )}
        {canShareCamera && (
          <PipButton
            onClick={onCamera}
            danger={!cameraEnabled}
            label={cameraEnabled ? "Stop video" : "Start video"}
          >
            {cameraEnabled ? (
              <CameraIcon className="size-4" />
            ) : (
              <CameraOffIcon className="size-4" />
            )}
          </PipButton>
        )}

        <div className="flex-1" />

        <button
          type="button"
          onClick={onBackToTab}
          className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12px] font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          Back to webinar
        </button>
      </div>
    </div>
  );
}

/* A control in the popped-out window, sized for a window rather than for a bar.
 *
 * Its own small component instead of MediaToggle: that one carries a device-picker chevron, a
 * live microphone meter and a menu that closes on outside clicks — none of which fit in a
 * 400px window, and a menu opening inside a floating window would be a popover inside a
 * popover. White-on-black directly rather than through the room tokens, because this document
 * is over somebody's desktop rather than inside the app's own surface.
 */
function PipButton({
  onClick,
  danger,
  label,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid size-8 shrink-0 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
        danger
          ? "bg-live-soft text-live hover:bg-live/20"
          : "text-white/80 hover:bg-white/10 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
