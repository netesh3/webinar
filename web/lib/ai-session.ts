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
  controls: Pick<SessionControls, "captionsEnabled" | "aiEnabled" | "serverCaptions">,
  canPublish: boolean,
): CaptionEngine {
  const display = controls.captionsEnabled === true;
  const capture = controls.aiEnabled === true;
  const run = canPublish && !controls.serverCaptions && (display || capture);
  return { run, display: run && display, store: run };
}
