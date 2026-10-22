import type { PresenceResponse } from "./api-types";

/* The pure half of lib/presence.ts: what one presence poll's answer means for the stage-invite
 * packets replayed onto the Room. Kept apart so it runs under node (presence-step.test.mts). */

/** A new invite to show, an invite that has gone (answered elsewhere, withdrawn or expired),
 *  or nothing new. `shown` is whether an invite from an earlier poll is being shown. */
export function presenceInviteStep(
  shown: boolean,
  res: Pick<PresenceResponse, "invite">,
): "show" | "clear" | null {
  if (res.invite && !shown) return "show";
  if (!res.invite && shown) return "clear";
  return null;
}

/** The data-channel packet the step stands in for: what the server sends to the stage. */
export function presencePacket(
  step: "show" | "clear",
  identity: string,
  res: Pick<PresenceResponse, "invite">,
  at: number,
): Record<string, unknown> {
  if (step === "show") {
    return {
      kind: "stage-invite",
      identity,
      audioOnly: res.invite?.audioOnly === true,
      recording: res.invite?.recording === true,
      at,
    };
  }
  return { kind: "stage-invite-clear", identity, at };
}
