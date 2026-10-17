import type { Participant, TrackPublication } from "livekit-client";

/* One screen share at a time.
 *
 * The room has exactly one presenter's screen. Before this, anybody allowed to share
 * could start a second share on top of the first; the stage showed whichever tile it
 * happened to find first and the other person kept presenting to nobody, with nothing
 * telling them so.
 *
 * The policy:
 *
 *   - The host or a co-host may take over. Their newest share wins, and whoever was
 *     sharing before stops.
 *   - Anybody else (a panelist, an attendee allowed to talk) is blocked while somebody
 *     is sharing. Among those, the share that started FIRST keeps the stage.
 *
 * A shared video file is published on the ScreenShare source, so it is covered by the
 * same rule without knowing about it.
 *
 * WHEN a share started comes from the SFU, not from a browser: LiveKit stamps a track's
 * `version` (a server clock, in microseconds) once, when its media first arrives, and
 * never changes it after. That is the same number the API's webhook sees (see
 * api/internal/api/share_lock.go), so every browser and the server agree on the order
 * without trusting anybody's clock — and without trusting a timestamp a participant
 * could write about themselves.
 *
 * The stamp is not always there yet. A local publication never carries it (the SFU
 * only stamps once media flows, after the publish response) and a remote one can be
 * a moment behind. Unknown is read as "newest": a share we cannot date yet is the one
 * that has just started, which is exactly what it is.
 */

/** One live screen share, however it was found. */
export type ShareCandidate = {
  identity: string;
  /** Host or co-host: may take the screen from somebody else. */
  privileged: boolean;
  /** The SFU's publish stamp in microseconds, or null when it is not known yet. */
  startedAt: number | null;
  /** Muted shares are not presenting — the server mutes the loser of a race. */
  muted: boolean;
};

/** Whose share should be on the stage. Null when nobody is presenting.
 *
 *  Deterministic for a given set, which is the whole point: every browser runs this on
 *  the same SFU data and the API runs the same rule, so they pick the same winner. */
export function pickShare<T extends ShareCandidate>(shares: readonly T[]): T | null {
  const live = shares.filter((s) => !s.muted);
  if (live.length === 0) return null;
  const at = (s: ShareCandidate) => s.startedAt ?? Number.POSITIVE_INFINITY;
  const privileged = live.filter((s) => s.privileged);
  if (privileged.length > 0) {
    // The newest host share: a takeover replaces whatever was there.
    return privileged.reduce((best, s) =>
      at(s) > at(best) || (at(s) === at(best) && s.identity < best.identity) ? s : best,
    );
  }
  // Nobody privileged: first come, first served.
  return live.reduce((best, s) =>
    at(s) < at(best) || (at(s) === at(best) && s.identity < best.identity) ? s : best,
  );
}

/** What the Share button should do for this person right now. */
export type ShareGate =
  | { kind: "start" }
  | { kind: "takeover"; sharer: string }
  | { kind: "blocked"; sharer: string };

/** `current` is the other person on the stage (pickShare over everybody else's shares),
 *  or null when nobody else is presenting. */
export function shareGate(
  privileged: boolean,
  current: { name: string } | null,
): ShareGate {
  if (!current) return { kind: "start" };
  return privileged
    ? { kind: "takeover", sharer: current.name }
    : { kind: "blocked", sharer: current.name };
}

/** Another participant's share, as seen from a browser that is sharing too. */
export type OtherShare = {
  identity: string;
  name: string;
  privileged: boolean;
  muted: boolean;
  /** It was already live when our own share was published, i.e. it is older than ours. */
  presentAtStart: boolean;
};

/** Why our own share has to stop, or null if it may carry on.
 *
 *  Decided from the order this browser SAW things in, not from SFU stamps, because a
 *  local publication has no stamp (see the top of this file). "Was it already there when
 *  ours started" is what this browser knows for certain. The one case it cannot
 *  settle — two people publishing in the same instant, neither seeing the other — is
 *  settled by the server, which mutes the loser; `mutedByServer` then stops us here. */
export function shouldYield(
  me: { privileged: boolean; mutedByServer: boolean },
  others: readonly OtherShare[],
): { reason: "muted" } | { reason: "takeover" | "taken"; by: string } | null {
  if (me.mutedByServer) return { reason: "muted" };
  for (const other of others) {
    if (other.muted) continue;
    if (me.privileged) {
      // A host keeps the screen against anything older (that is the share being taken
      // over) and against any non-host (who should never have got through). Only a
      // newer host share replaces it.
      if (other.privileged && !other.presentAtStart) {
        return { reason: "takeover", by: other.name };
      }
      continue;
    }
    // Not a host: every host share outranks us, newer or older, and so does a share by
    // anybody that was already there first.
    if (other.privileged) return { reason: "takeover", by: other.name };
    if (other.presentAtStart) return { reason: "taken", by: other.name };
  }
  return null;
}

/** The toast for a share that was stopped by somebody else's. */
export function yieldMessage(
  why: NonNullable<ReturnType<typeof shouldYield>>,
): string {
  switch (why.reason) {
    case "takeover":
      return `${why.by} took over the screen share.`;
    case "taken":
      return `${why.by} is already sharing, so your share was stopped.`;
    case "muted":
      return "Somebody else is sharing, so your share was stopped.";
  }
}

/** Host or co-host, read from the metadata our API minted into the participant's token.
 *  Metadata rather than the identity prefix, the same as participantRole: a role can
 *  change in place (host handoff, co-host granted mid-session). */
export function isPrivileged(participant: Pick<Participant, "metadata">): boolean {
  const raw = participant.metadata;
  if (!raw) return false;
  try {
    const meta = JSON.parse(raw) as { role?: unknown; coHost?: unknown };
    return meta.role === "host" || meta.coHost === true;
  } catch {
    return false;
  }
}

/** The SFU's publish stamp in microseconds, or null when this publication has none yet. */
export function shareStartedAt(
  publication: Pick<TrackPublication, "trackInfo"> | undefined,
): number | null {
  const micro = publication?.trackInfo?.version?.unixMicro;
  if (micro === undefined || micro === null) return null;
  const n = Number(micro);
  return n > 0 ? n : null;
}
