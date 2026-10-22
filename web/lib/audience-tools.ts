/* What a viewer of the stream does not get, as pure functions.
 *
 * A streaming viewer (edge LL-HLS or CDN, docs/edge-delivery.md) watches a picture; they are
 * not in a call. So the room drops the chrome that only means something to somebody in one:
 *
 *   participants  a roster of people they cannot see or talk to;
 *   invite        the share link (the landing page already has one);
 *   settings      microphone, camera and speaker pickers for a viewer with no devices
 *                 published and a player that plays through the default output.
 *
 * Chat, Q&A, polls, reactions, raise hand and Leave stay, each still behind its own control.
 *
 * Pure so node can test it — see audience-tools.test.mts, run by `make test-web`. */

import type { ToolId } from "./tools.ts";

export const STREAMING_AUDIENCE_HIDDEN_TOOLS: readonly ToolId[] = [
  "participants",
  "invite",
  "settings",
];

/** The tools for this person, narrowed for a streaming viewer. Anyone else's list is
 *  returned as it came, order and all. */
export function streamingAudienceTools(tools: readonly ToolId[], streaming: boolean): ToolId[] {
  if (!streaming) return [...tools];
  return tools.filter((t) => !STREAMING_AUDIENCE_HIDDEN_TOOLS.includes(t));
}

/** Whether the header shows the meeting-info card (title, ID, invite link).
 *
 * Not to the audience: a streaming viewer (cdnStage) or a WebRTC attendee with nothing to
 * publish. The host, panelists, an attendee brought on stage, and everyone in a meeting
 * keep it. */
export function showsMeetingInfo(input: {
  isHost: boolean;
  canPublish: boolean;
  meeting: boolean;
  cdnStage: boolean;
}): boolean {
  if (input.cdnStage) return false;
  if (input.isHost || input.meeting) return true;
  return input.canPublish;
}
