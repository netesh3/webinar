"use client";

import { useState, type ReactNode } from "react";
import { formatElapsed, useElapsed } from "@/lib/own-share";
import {
  CameraIcon,
  CameraOffIcon,
  ChatIcon,
  HandIcon,
  MicIcon,
  MicOffIcon,
  ScreenShareOffIcon,
} from "../icons";

/* The mini control bar: a ≈360×110 always-on-top window (Document Picture-in-Picture).
 *
 * For the presenter who has gone off to their slides — or shared the entire screen, where a
 * whole tab of the room on everybody's screen is the thing to avoid. Rendered by the control
 * bar through a portal into the PiP window's document, so every button runs the bar's own
 * handler with the bar's own guards (a host-muted panelist is refused here exactly as there),
 * and every number is the bar's own state: nothing to keep in sync, because it is one tree.
 *
 * Leave is two steps, inline. The room's own confirmations are popovers and modals in the
 * MAIN document, which this window cannot show — so a host, whose leave is a menu of
 * choices, is sent back to the tab with that menu open instead.
 */

export const MINI_CONTROLS_SIZE = { width: 360, height: 110 } as const;

export function MiniControls({
  micEnabled,
  cameraEnabled,
  canSpeak,
  canShareCamera,
  onMic,
  onCamera,
  sharing,
  onStopShare,
  shareStartedAt,
  joinedAt,
  hands,
  showHands,
  unreadChat,
  onChat,
  meeting,
  hostLeave,
  onLeave,
}: {
  micEnabled: boolean;
  cameraEnabled: boolean;
  canSpeak: boolean;
  canShareCamera: boolean;
  onMic: () => void;
  onCamera: () => void;
  /** Our own share (screen or video file) is live. */
  sharing: boolean;
  onStopShare: () => void;
  /** Date.now() when our screen share started; null when not sharing a screen. */
  shareStartedAt: number | null;
  /** Date.now() when this room was joined, for the clock while not sharing. */
  joinedAt: number;
  hands: number;
  /** Only somebody who can do something about a raised hand sees the count. */
  showHands: boolean;
  unreadChat: number;
  /** Null where chat is not available to this person. */
  onChat: (() => void) | null;
  meeting: boolean;
  /** A host's leave is a menu in the main window; the window is brought forward instead. */
  hostLeave: boolean;
  onLeave: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const elapsed = useElapsed(shareStartedAt ?? joinedAt);
  const what = meeting ? "meeting" : "webinar";

  return (
    <div className="flex h-dvh w-full flex-col justify-between gap-1 bg-[#0b0d12] px-2.5 py-2 text-white">
      <div className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className={`size-1.5 shrink-0 rounded-full ${sharing ? "animate-pulse bg-ok" : "bg-white/40"}`}
        />
        <span className="truncate text-[12px] font-medium text-white/85">
          {sharing ? "Sharing" : `In the ${what}`}
        </span>
        <span className="shrink-0 text-[12px] tabular-nums text-white/55">
          {formatElapsed(elapsed)}
        </span>
        <div className="flex-1" />
        {showHands && (
          <span
            className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] tabular-nums ${
              hands > 0 ? "bg-amber-400/15 text-amber-300" : "text-white/55"
            }`}
            title={`${hands} raised ${hands === 1 ? "hand" : "hands"}`}
            aria-label={`${hands} raised ${hands === 1 ? "hand" : "hands"}`}
          >
            <HandIcon className="size-3.5" />
            {hands}
          </span>
        )}
        {onChat && (
          <button
            type="button"
            onClick={onChat}
            title="Open chat in the webinar window"
            aria-label={`Chat, ${unreadChat} unread. Opens chat in the ${what} window`}
            className={`inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] tabular-nums transition-colors outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40 ${
              unreadChat > 0 ? "text-sky-300" : "text-white/55"
            }`}
          >
            <ChatIcon className="size-3.5" />
            {unreadChat > 99 ? "99+" : unreadChat}
          </button>
        )}
      </div>

      {confirming ? (
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
            Leave the {what}?
          </span>
          <TextButton onClick={() => setConfirming(false)}>Cancel</TextButton>
          <TextButton
            danger
            onClick={() => {
              setConfirming(false);
              onLeave();
            }}
          >
            Leave
          </TextButton>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {canSpeak && (
            <IconButton onClick={onMic} danger={!micEnabled} label={micEnabled ? "Mute" : "Unmute"}>
              {micEnabled ? <MicIcon className="size-4" /> : <MicOffIcon className="size-4" />}
            </IconButton>
          )}
          {canShareCamera && (
            <IconButton
              onClick={onCamera}
              danger={!cameraEnabled}
              label={cameraEnabled ? "Stop video" : "Start video"}
            >
              {cameraEnabled ? <CameraIcon className="size-4" /> : <CameraOffIcon className="size-4" />}
            </IconButton>
          )}
          {sharing && (
            <TextButton danger onClick={onStopShare}>
              <ScreenShareOffIcon className="size-4" />
              Stop sharing
            </TextButton>
          )}
          <div className="flex-1" />
          <TextButton onClick={() => (hostLeave ? onLeave() : setConfirming(true))}>Leave</TextButton>
        </div>
      )}
    </div>
  );
}

function IconButton({
  onClick,
  danger,
  label,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid size-9 shrink-0 place-items-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
        danger
          ? "bg-live-soft text-live hover:bg-live/20"
          : "bg-white/8 text-white/85 hover:bg-white/15 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function TextButton({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
        danger
          ? "bg-live text-on-live hover:bg-live/90"
          : "bg-white/8 text-white/85 hover:bg-white/15 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
