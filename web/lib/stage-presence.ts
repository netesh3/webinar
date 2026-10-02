import { isBotOrEgress } from "./roster.ts";

/* Whether the stage is waiting for a host, or the host is already in the room
 * with nothing to watch yet.
 *
 * The empty stage used to mean "nobody is publishing a camera or a screen
 * share." That is the wrong signal. A host (or a panelist) who has joined with
 * the microphone muted and the camera off has started: the attendee is in the
 * room, and the stage should show that person with the camera off. Waiting is
 * only for when nobody who can host is connected — a scheduled webinar the
 * host has not gone live for, or the minutes after the doors open and before
 * they enter.
 *
 * A published track is not required, and a paused recording is not an input.
 * Pause is a recorder state. It must not put the audience back on the waiting
 * screen.
 *
 * Once anybody is publishing a camera or a screen share, this returns "media"
 * and the stage lays those tracks out exactly as before. Placeholders are only
 * for the empty stage, so turning the camera on or sharing a screen does not
 * grow an extra tile.
 */

export const CAMERA_OFF_LABEL = "Camera off";
export const WAITING_FOR_HOST_LABEL = "Waiting for the host to start";

export type StageSeat = {
  identity: string;
  role: string;
  /** A camera publication is on the stage, muted or not. */
  hasCamera: boolean;
  hasScreenShare: boolean;
};

export type StagePresence =
  | { kind: "media" }
  | { kind: "camera-off"; identities: string[] }
  /** No camera-off tile to add. The stage stays on its existing empty state:
   *  the waiting card for an attendee, the connecting preview for a presenter. */
  | { kind: "holding" };

export function emptyStageLabel(kind: "camera-off" | "holding"): string {
  return kind === "camera-off" ? CAMERA_OFF_LABEL : WAITING_FOR_HOST_LABEL;
}

function isPresenter(role: string): boolean {
  return role === "host" || role === "panelist";
}

/** Who, if anyone, should replace the "waiting for the host" card.
 *
 * `viewerCanPresent` drops the viewer's own identity from the camera-off list.
 * Their empty stage is the connecting preview (or the dot when they joined
 * with the camera off). Putting an initials tile there would flash one in the
 * gap between connecting and the first published frame, which is the path
 * that starts with the camera already on. Everyone else still sees them. */
export function stagePresence(input: {
  seats: readonly StageSeat[];
  viewerIdentity: string;
  viewerCanPresent: boolean;
}): StagePresence {
  const seats = input.seats.filter((seat) => !isBotOrEgress(seat.identity));
  if (seats.some((seat) => seat.hasCamera || seat.hasScreenShare)) {
    return { kind: "media" };
  }

  const presenters = seats
    .filter((seat) => isPresenter(seat.role))
    .filter((seat) => !(input.viewerCanPresent && seat.identity === input.viewerIdentity))
    .sort((a, b) => {
      const rank = (role: string) => (role === "host" ? 0 : 1);
      const byRole = rank(a.role) - rank(b.role);
      return byRole !== 0 ? byRole : a.identity.localeCompare(b.identity);
    });

  if (presenters.length === 0) return { kind: "holding" };
  return { kind: "camera-off", identities: presenters.map((seat) => seat.identity) };
}
