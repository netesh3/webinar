"use client";

import { useMemo, type ReactNode } from "react";
import type { ToolId } from "@/lib/tools";
import { TOOL_IDS } from "@/lib/tools";
import { meetingTools } from "@/lib/meeting-room";
import {
  ChatIcon,
  HandIcon,
  PlayIcon,
  PollIcon,
  QuestionIcon,
  SettingsIcon,
  SlidersIcon,
  SmileIcon,
  SpeakerViewIcon,
  UserPlusIcon,
  UsersIcon,
  YouTubeIcon,
  LinkedInIcon,
  InstagramIcon,
  FacebookIcon,
} from "../icons";

/* The registry: one entry per tool, and the only place that knows what a tool is.
 *
 * Everything downstream — the bar, the More grid, the windows — reads from here,
 * so adding a tool is one entry rather than four edits that have to agree. The
 * previous design had the same four features listed in the control bar, in the
 * side panel's tab array, in a label map and in the overflow menu; they drifted,
 * and Polls ended up in three of the four.
 *
 * Two kinds, and the distinction is not cosmetic:
 *
 *   window   opens a floating window. Has content.
 *   action   happens immediately — a reaction is sent, a hand goes up. Wrapping
 *            those in a window would put a click between the user and a gesture
 *            that is supposed to be instant.
 */

export type ToolKind = "window" | "action";

export type Tool = {
  id: ToolId;
  kind: ToolKind;
  /** On the bar and in the grid. Short: it sits under a 20px icon. */
  label: string;
  /** In the More menu, where a cell has room for a few more words than a
   *  toolbar button does. Falls back to `label`. */
  menuLabel?: string;
  /** In the window's title bar and as the accessible name, where there is room
   *  to be unambiguous. */
  title: string;
  icon: (props: { className?: string }) => ReactNode;
  /** Keep the content mounted while the window is minimised.
   *
   *  True where there is something to lose — a half-typed message, a scroll
   *  position — and false where being mounted costs something. Polls is the
   *  reason this is a flag and not a constant: it polls for the tally of an open
   *  poll every four seconds, and a minimised window doing that for an hour is a
   *  request nobody is looking at. */
  keepMounted: boolean;
};

const TOOLS: Record<ToolId, Tool> = {
  chat: {
    id: "chat",
    kind: "window",
    label: "Chat",
    title: "Chat",
    icon: ChatIcon,
    keepMounted: true,
  },
  qa: {
    id: "qa",
    kind: "window",
    label: "Q&A",
    title: "Questions and answers",
    icon: QuestionIcon,
    keepMounted: true,
  },
  polls: {
    id: "polls",
    kind: "window",
    label: "Polls",
    title: "Polls and quizzes",
    icon: PollIcon,
    keepMounted: false,
  },
  participants: {
    id: "participants",
    kind: "window",
    label: "Participants",
    title: "Participants",
    icon: UsersIcon,
    keepMounted: true,
  },
  invite: {
    id: "invite",
    /* An action, not a window — Zoom's own Invite is a two-item popover, not a
     * draggable panel, and a link plus a preview of what gets copied was more
     * chrome than the task needed. */
    kind: "action",
    label: "Invite",
    title: "Invite people",
    icon: UserPlusIcon,
    keepMounted: false,
  },
  reactions: {
    id: "reactions",
    kind: "action",
    label: "React",
    title: "Send a reaction",
    icon: SmileIcon,
    keepMounted: false,
  },
  hand: {
    id: "hand",
    kind: "action",
    label: "Raise hand",
    title: "Raise hand",
    icon: HandIcon,
    keepMounted: false,
  },
  layout: {
    id: "layout",
    // An action, not a window: choosing a layout is a glance at three options, and
    // a draggable window for it would be a window you close every time.
    kind: "action",
    label: "Layout",
    title: "Change layout — speaker, grid, or spotlight",
    icon: SpeakerViewIcon,
    keepMounted: false,
  },
  settings: {
    id: "settings",
    kind: "window",
    label: "Settings",
    title: "Audio and video settings",
    icon: SettingsIcon,
    keepMounted: false,
  },
  host: {
    id: "host",
    kind: "window",
    label: "Host tools",
    title: "Host controls",
    icon: SlidersIcon,
    keepMounted: false,
  },
  captions: {
    id: "captions",
    // An on/off switch for the whole room, not a window.
    kind: "action",
    label: "Captions",
    title: "Live captions for everyone",
    icon: CaptionsIcon,
    keepMounted: false,
  },
  sharefile: {
    id: "sharefile",
    // Opens the share picker's own dialog rather than a tool window.
    kind: "action",
    label: "Video file",
    // Short in More so the Zoom-style grid stays one line per cell.
    menuLabel: "Video file",
    title: "Share a video file",
    icon: PlayIcon,
    keepMounted: false,
  },
  youtube: {
    id: "youtube",
    // Opens its own dialog (stream-to-youtube.tsx) rather than a tool window.
    kind: "action",
    label: "YouTube",
    menuLabel: "Stream to YouTube",
    title: "Stream to YouTube",
    icon: YouTubeIcon,
    keepMounted: false,
  },
  linkedin: {
    id: "linkedin",
    // Opens its own dialog (stream-to-linkedin.tsx) rather than a tool window.
    kind: "action",
    label: "LinkedIn",
    menuLabel: "Stream to LinkedIn",
    title: "Stream to LinkedIn Live",
    icon: LinkedInIcon,
    keepMounted: false,
  },
  instagram: {
    id: "instagram",
    // Opens its own dialog (stream-to-platform.tsx) rather than a tool window.
    kind: "action",
    label: "Instagram",
    menuLabel: "Stream to Instagram",
    title: "Stream to Instagram Live",
    icon: InstagramIcon,
    keepMounted: false,
  },
  facebook: {
    id: "facebook",
    kind: "action",
    label: "Facebook",
    menuLabel: "Stream to Facebook",
    title: "Stream to Facebook Live",
    icon: FacebookIcon,
    keepMounted: false,
  },
  whiteboard: {
    id: "whiteboard",
    // Takes the stage for everyone (whiteboard/whiteboard-stage.tsx) rather
    // than opening a window, the way a screen share does.
    kind: "action",
    label: "Whiteboard",
    title: "Open a whiteboard everyone can see",
    icon: WhiteboardIcon,
    keepMounted: false,
  },
};

/** A board on an easel, sized like the other 20px icons. */
function WhiteboardIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M7 12.5l3-3.5 2.5 2.5L17 7.5" />
      <path d="M12 16v4M8.5 20h7" />
    </svg>
  );
}

/** "CC" as a glyph, sized like the other 20px icons. */
function CaptionsIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid place-items-center text-[11px] leading-none font-semibold ${className ?? ""}`}
    >
      CC
    </span>
  );
}

export function tool(id: ToolId): Tool {
  return TOOLS[id];
}

/**
 * Which tools this person may use, in a stable order.
 *
 * The gates are the same ones the old control bar applied inline, gathered into
 * one place so the bar and the grid cannot come to different conclusions — which
 * they did: Polls appeared in the overflow menu for an attendee whose host had
 * turned polls off, because the menu's copy of the condition was never updated
 * alongside the button's.
 *
 * Takes its inputs as arguments rather than reading the room context, because the
 * context needs the answer: the layout hook that owns the windows lives in the
 * provider, and it has to be told what is available before there is a provider to
 * read from.
 */
export function availableTools(input: {
  isHost: boolean;
  pollsEnabled: boolean;
  reactionsEnabled: boolean;
  raiseHandEnabled: boolean;
  /** JoinResponse.whiteboard: the host's switch is on and this person is on
   *  the stage. Absent means off, so every existing caller is unchanged. */
  whiteboard?: boolean;
}): ToolId[] {
  /* Settings is unconditional, and was briefly not.
   *
   * Gating it on `canPublish` looked right — an attendee has no camera to choose —
   * and was wrong twice over. The window also holds the speaker picker and the
   * connection readout, which is exactly what somebody watching wants when the
   * audio is coming out of the wrong device. And publish permission arrives a
   * moment after the join response, so the tool appeared, vanished and came back
   * at the end of the grid instead of in its own place.
   */
  /* Invite is unconditional, including for the audience.
   *
   * It shares the LANDING page link, not a credential: whoever opens it still has to
   * register, or pass the passcode, or be approved by the host. The slug has always been
   * the shareable part — that is what a "you're invited" link is — so an attendee handing
   * it to a colleague can only offer them the same front door they came through.
   */
  // Layout is deliberately absent from this bar/More-grid system — it lives only
  // in the header's ViewsMenu now (webinar-room.tsx), which renders the same
  // LayoutMenu directly rather than going through a pinnable ToolId. Removing it
  // here does not touch that: ViewsMenu doesn't read this list at all. "layout"
  // stays a valid ToolId (lib/tools.ts) so any already-pinned/overflow-persisted
  // copy from before this change is simply filtered out below, same as when
  // raiseHandEnabled/reactionsEnabled toggle a tool off for someone mid-session.
  const allowed = new Set<ToolId>(["chat", "qa", "participants", "invite", "settings"]);

  // The host always has Polls — writing the questions is what you do before
  // turning it on — and everyone else only once the control is on.
  if (input.isHost || input.pollsEnabled) allowed.add("polls");
  if (input.reactionsEnabled) allowed.add("reactions");
  // A host raising their own hand is asking themselves for permission.
  if (input.raiseHandEnabled && !input.isHost) allowed.add("hand");
  if (input.isHost) allowed.add("host");
  // Captions is the host's switch for the whole room.
  if (input.isHost) allowed.add("captions");
  // Streaming to YouTube is the host's — the same gate the bar button always had.
  if (input.isHost) allowed.add("youtube");
  if (input.isHost) allowed.add("linkedin");
  if (input.isHost) allowed.add("instagram");
  if (input.isHost) allowed.add("facebook");
  /* Share a video file is offered to everyone here and narrowed in the control
   * bar (usableTools), because what it needs — the share permission, a browser
   * that can capture a video element, a real room — is not known at this level,
   * and the permission arrives after the join. Gating it here would reconcile a
   * panelist's pin away in the moment before their permission lands. */
  allowed.add("sharefile");
  // Behind the host's account switch — see JoinResponse.whiteboard.
  if (input.whiteboard) allowed.add("whiteboard");

  return TOOL_IDS.filter((id) => allowed.has(id));
}

/** The same thing, memoised on the primitives rather than on the objects that
 *  hold them — `controls` is a fresh object on every metadata broadcast, and
 *  depending on it would recompute the list on every reaction anybody sends. */
export function useAvailableTools(input: {
  isHost: boolean;
  controls: {
    pollsEnabled: boolean;
    reactionsEnabled: boolean;
    raiseHandEnabled: boolean;
  };
  whiteboard?: boolean;
  /** A meeting (JoinResponse.meeting): no raise hand and no streaming — see
   *  lib/meeting-room.ts meetingTools. */
  meeting?: boolean;
}): ToolId[] {
  const { isHost, controls, whiteboard = false, meeting = false } = input;
  return useMemo(
    () =>
      meetingTools(
        availableTools({
          isHost,
          pollsEnabled: controls.pollsEnabled,
          reactionsEnabled: controls.reactionsEnabled,
          raiseHandEnabled: controls.raiseHandEnabled,
          whiteboard,
        }),
        meeting,
      ),
    [
      isHost,
      controls.pollsEnabled,
      controls.reactionsEnabled,
      controls.raiseHandEnabled,
      whiteboard,
      meeting,
    ],
  );
}
