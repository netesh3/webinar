import type { LiveParticipant } from "./api-types";

/** One row we might hand the session to — roster or LiveKit client shape. */
export type HostCandidateSource = {
  identity: string;
  name?: string;
  role?: string;
  canPublish?: boolean;
  /** A co-host right now: LiveParticipant.coHost, or the coHost in LiveKit metadata. */
  coHost?: boolean;
};

/**
 * Who the host may hand the session to from Leave: a co-host in the room, and nobody else
 * (api handleTransferHost answers not_a_cohost otherwise). Webinars and meetings alike.
 *
 * Either kind of identity: an invited panelist (`user_*`), or an attendee brought on stage /
 * a meeting guest (`att_*`) — the server resolves an `att_` to the confirmed account behind
 * it, the same account "Make co-host" required, and that account becomes the host.
 *
 * `canPublish` is NOT required. A co-host the host muted still has role `panelist` and must
 * appear in the list; the transfer re-grants host publish rights on success.
 */
export function isEligibleHostCandidate(p: HostCandidateSource, selfIdentity: string): boolean {
  if (!p.identity || p.identity === selfIdentity) return false;
  if (!/^(user|att)_./.test(p.identity)) return false;
  if (p.role === "host" || p.role === "attendee") return false;
  return p.coHost === true;
}

/** The co-hosts who can take over as host, each once. */
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
      name: p.name || "Co-host",
      role: "panelist",
      joinedAt: "",
      publishing: [],
      audioMuted: true,
      hidden: false,
      canPublish: p.canPublish ?? true,
      canSpeak: true,
      audioOnly: false,
      mutedByHost: false,
      coHost: true,
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

/** The coHost flag in a participant's LiveKit metadata (lk.Metadata), false if unreadable. */
export function metadataCoHost(raw: string | undefined): boolean {
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as { coHost?: unknown }).coHost === true;
  } catch {
    return false;
  }
}
