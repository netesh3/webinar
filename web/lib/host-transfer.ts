import type { LiveParticipant } from "./api-types";

/** One row we might hand the session to — roster or LiveKit client shape. */
export type HostCandidateSource = {
  identity: string;
  name?: string;
  role?: string;
  canPublish?: boolean;
};

/**
 * Who may take over as host from Leave → Assign host.
 *
 * Must be a signed-in stage seat (`user_*`): TransferHost looks up that account and
 * requires them on the webinar's panelist list. Audience (`att_*`) and promoted
 * attendees keep an attendee identity even when they publish, so they cannot own
 * the webinar.
 *
 * `canPublish` is NOT required. A panelist the host muted (or whose permission
 * record has not arrived yet) still has role `panelist` and must appear in the
 * picker — requiring publish was why the list looked empty with a panelist in
 * the room. The transfer API re-grants host publish rights on success.
 */
export function isEligibleHostCandidate(
  p: HostCandidateSource,
  selfIdentity: string,
): boolean {
  if (!p.identity || p.identity === selfIdentity) return false;
  if (!p.identity.startsWith("user_")) return false;
  if (p.role === "host") return false;
  if (p.role === "panelist") return true;
  // Metadata missing or stale: a publishing signed-in seat is still on stage.
  return !!p.canPublish;
}

/** Panelists (signed-in stage seats) who can take over as host. */
export function eligibleHostCandidates(
  participants: HostCandidateSource[] | null | undefined,
  selfIdentity: string,
): LiveParticipant[] {
  if (!participants) return [];
  const out: LiveParticipant[] = [];
  const seen = new Set<string>();
  for (const p of participants) {
    if (!isEligibleHostCandidate(p, selfIdentity) || seen.has(p.identity)) continue;
    seen.add(p.identity);
    out.push({
      identity: p.identity,
      name: p.name || "Panelist",
      role: "panelist",
      joinedAt: "",
      publishing: [],
      audioMuted: true,
      hidden: false,
      canPublish: p.canPublish ?? true,
      canSpeak: true,
      audioOnly: false,
      mutedByHost: false,
      // A co-host is still eligible to take over as host outright — being the
      // host's equal is not the same as being the host — but this picker has
      // no use for the distinction, so it is not threaded through here.
      coHost: false,
    });
  }
  return out;
}

/** Prefer roster names when both the API and the SFU client list the same person. */
export function mergeHostCandidates(
  roster: HostCandidateSource[] | null | undefined,
  remotes: HostCandidateSource[],
  selfIdentity: string,
): LiveParticipant[] {
  return eligibleHostCandidates([...(roster ?? []), ...remotes], selfIdentity);
}
