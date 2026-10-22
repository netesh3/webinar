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

/** The switch once AI has been off at any point of the live session: the server keeps the
 *  whole session out of AI from then on (controls.aiOffThisSession, migration 0133), even with
 *  the switch back on, so the room says so instead of showing a switch that does nothing. */
export const AI_OFF_THIS_SESSION_TOOLTIP =
  "AI was switched off during this session, so it stays off until the session ends: no Q&A assistant, recap or notes. It is back on for the next session.";

/** Asked before AI is switched off in a live session, because it cannot be undone there. */
export const AI_OFF_CONFIRM =
  "Turn AI off for the rest of this session?\n\nThe Q&A assistant, recap and notes stop, and switching AI back on won't bring them back until the next session.";

/** Whether AI is actually in use for this session: the account has it, the room's switch is
 *  on, and it has not been off at any point while live. aiEnabled alone is not enough: after
 *  an off and an on during the live session it reads true while the server refuses every AI
 *  use (sessionAIBlock), which is how the Q&A assistant silently disappeared mid-session. */
export function sessionAIOn(
  controls: Pick<SessionControls, "aiAvailable" | "aiEnabled" | "aiOffThisSession">,
): boolean {
  return controls.aiAvailable === true && controls.aiEnabled === true && controls.aiOffThisSession !== true;
}

/** Whether the room's switch is locked off: AI was off at some point of this live session.
 *  Only while live: the next go-live starts clean (the server resets the mark). */
export function aiLockedOff(
  controls: Pick<SessionControls, "aiAvailable" | "aiOffThisSession">,
  status: string | null,
): boolean {
  return controls.aiAvailable === true && controls.aiOffThisSession === true && status === "live";
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
  // A session already out of AI keeps no transcript for it, whatever the switch says now.
  const capture = controls.aiEnabled === true && controls.aiOffThisSession !== true;
  const run = canPublish && !controls.serverCaptions && (display || capture);
  return { run, display: run && display, store: run };
}
