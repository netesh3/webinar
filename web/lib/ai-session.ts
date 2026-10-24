/* The room's AI switch (SessionControls.aiEnabled), the pure half.
 *
 * Two separate questions about live speech, answered by two separate controls:
 *
 *   display   controls.captionsEnabled: are captions SHOWN to people?
 *   capture   controls.aiEnabled: is a transcript KEPT for the AI recap?
 *
 * Where the server caption agent is live in the room (controls.serverCaptions) it does both
 * (the API stores its lines, and fans them out only while captions are shown), so no browser
 * runs anything. Otherwise each speaker's browser runs the one on-device engine
 * (lib/local-captions.ts) when either is wanted, broadcasting lines only for display. One
 * engine, never two: captions shown and AI on is the same engine, with the overlay. */

import type { SessionControls } from "./api-types.ts";

export const AI_TOGGLE_TOOLTIP = "AI recap and notes for this session. Turn off to keep this session out of AI.";

/** The switch while AI is paused in a live session (controls.aiOffThisSession). */
export const AI_PAUSED_TOOLTIP =
  "AI is paused. Turn it back on to resume; anything said or asked while it was off stays out of AI.";

/** Asked before AI is switched off in a live session: it pauses, it does not end. */
export const AI_OFF_CONFIRM =
  "Pause AI for this session?\n\nAI pauses until you turn it back on; what's said meanwhile stays out of AI.";

/** Asked before AI is switched back on in a live session. */
export const AI_RESUME_CONFIRM =
  "Resume AI for this session?\n\nAnything said or asked while AI was off stays out of AI.";

/** The Q&A panel's line while AI is paused. */
export const AI_PAUSED_NOTE = "AI is paused";

/** Whether AI is in use for this session right now: the account has it, the room's switch is
 *  on, and it is not paused (migration 0143: a pause during the live session lasts until the
 *  host turns AI back on). aiOffThisSession is read as well as aiEnabled so the two can never
 *  disagree on screen: an "on" switch over a session the server treats as paused is how the
 *  Q&A assistant once vanished mid-session with nothing saying why. */
export function sessionAIOn(
  controls: Pick<SessionControls, "aiAvailable" | "aiEnabled" | "aiOffThisSession">,
): boolean {
  return controls.aiAvailable === true && controls.aiEnabled === true && controls.aiOffThisSession !== true;
}

/** Whether AI is paused right now: the switch is off during the live session. Only while
 *  live: off before or after a session is just the switch. */
export function aiPaused(
  controls: Pick<SessionControls, "aiAvailable" | "aiEnabled" | "aiOffThisSession">,
  status: string | null,
): boolean {
  return controls.aiAvailable === true && status === "live" && !sessionAIOn(controls);
}

/** What a live session's switch asks before it flips: pausing or resuming. Null when it
 *  flips without asking (not live). */
export function aiToggleConfirm(on: boolean, status: string | null): string | null {
  if (status !== "live") return null;
  return on ? AI_OFF_CONFIRM : AI_RESUME_CONFIRM;
}

/** The Results note for a session AI was paused in (aiPausedMin on the recap and leads),
 *  or null when it never was. */
export function aiPausedResultsNote(min: number | undefined): string | null {
  if (!min || min <= 0) return null;
  return `AI was paused for ${min} min; that part isn't included.`;
}

/** Whether this person gets the room's AI switch: the host or a co-host, and only for a
 *  session whose host's account has AI at all. Everyone else sees no control. */
export function aiToggleVisible(isHost: boolean, controls: Pick<SessionControls, "aiAvailable">): boolean {
  return isHost && controls.aiAvailable === true;
}

export type CaptionEngine = {
  /** Run the on-device engine in this tab. */
  run: boolean;
  /** Broadcast its lines to the room as captions (and so show them). */
  display: boolean;
  /** Persist its lines for the transcript (always, while it runs). */
  store: boolean;
};

/** What this browser's on-device caption engine should do. */
export function captionEngine(
  controls: Pick<SessionControls, "captionsEnabled" | "aiEnabled" | "aiOffThisSession" | "serverCaptions">,
  canPublish: boolean,
): CaptionEngine {
  const display = controls.captionsEnabled === true;
  // Paused: no transcript is kept for the AI until it is resumed.
  const capture = controls.aiEnabled === true && controls.aiOffThisSession !== true;
  const run = canPublish && !controls.serverCaptions && (display || capture);
  return { run, display: run && display, store: run };
}

export type CaptionsStatus = {
  /** The control's label: off, or which source is captioning the room. */
  label: string;
  /** The longer line for its tooltip. */
  title: string;
  /** Captions are being made on the speakers' own devices right now. */
  onDevice: boolean;
};

/** What the host's captions control says about the room's captions: off, from the server
 *  (the caption agent is live: controls.serverCaptions), or on each speaker's device, either
 *  while the agent is on its way or paused (serverCaptionsPending) or because server captions
 *  are unavailable (refused, failed, or not set up). `reason` is the server's answer when the
 *  host's own switch got one. */
export function captionsStatus(
  controls: Pick<SessionControls, "captionsEnabled" | "serverCaptions" | "serverCaptionsPending">,
  recording: boolean,
  reason?: string | null,
): CaptionsStatus {
  const rec = recording ? " This session is being recorded." : "";
  if (controls.captionsEnabled !== true) {
    return { label: "Captions off", title: "Turn on captions for everyone", onDevice: false };
  }
  if (controls.serverCaptions === true) {
    return {
      label: "Captions: server",
      title: `Captions are on for everyone, from the server.${rec}`,
      onDevice: false,
    };
  }
  if (controls.serverCaptionsPending === true) {
    return {
      label: "Captions: on this device (server starting)",
      title: `Captions are on for everyone. Each speaker's device makes them until server captions are live.${rec}`,
      onDevice: true,
    };
  }
  const why = reason?.trim() ? ` ${reason.trim()}` : "";
  return {
    label: "Captions: on this device (server captions unavailable)",
    title: `Captions are on for everyone, made on each speaker's device: server captions are unavailable.${why}${rec}`,
    onDevice: true,
  };
}
