"use client";

import { useMemo, type ReactNode } from "react";
import type { ToolId } from "@/lib/tools";
import { TOOL_IDS } from "@/lib/tools";
import {
  ChatIcon,
  HandIcon,
  PollIcon,
  QuestionIcon,
  SettingsIcon,
  SlidersIcon,
  SmileIcon,
  SpeakerViewIcon,
  UserPlusIcon,
  UsersIcon,
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
};

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
}): ToolId[] {
  const { isHost, controls } = input;
  return useMemo(
    () =>
      availableTools({
        isHost,
        pollsEnabled: controls.pollsEnabled,
        reactionsEnabled: controls.reactionsEnabled,
        raiseHandEnabled: controls.raiseHandEnabled,
      }),
    [
      isHost,
      controls.pollsEnabled,
      controls.reactionsEnabled,
      controls.raiseHandEnabled,
    ],
  );
}
