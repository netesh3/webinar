/* What one server-sent event means to an edge viewer's room (lib/edge-events.ts).
 *
 * Pure, so the routing is testable without a browser: the hook turns each action into a
 * LiveKit-shaped event on the room's emitter (so the shared hooks — chat, Q&A, polls, raised
 * hands, controls — work unchanged), or into a callback for the few things only the edge
 * room handles: being promoted, demoted or removed. */

export type EdgeAction =
  | { type: "packet"; data: string }
  | { type: "meta"; data: string }
  | { type: "refetch"; kind: string }
  | { type: "promoted" }
  | { type: "demoted" }
  | { type: "removed" }
  | { type: "reconnect" }
  | { type: "ignore" };

/** Packet kinds addressed to this viewer that change which room they are in. */
const STAGE_KINDS: Record<string, EdgeAction["type"]> = {
  "stage-granted": "promoted",
  "stage-revoked": "demoted",
  removed: "removed",
};

export function routeEdgeEvent(kind: string, data: string, identity: string): EdgeAction {
  switch (kind) {
    case "meta":
      return { type: "meta", data };
    case "reconnect":
      return { type: "reconnect" };
    case "refetch": {
      try {
        const parsed = JSON.parse(data) as { kind?: unknown };
        return { type: "refetch", kind: typeof parsed.kind === "string" ? parsed.kind : "" };
      } catch {
        return { type: "refetch", kind: "" };
      }
    }
    case "packet": {
      let head: { kind?: unknown; identity?: unknown };
      try {
        head = JSON.parse(data) as typeof head;
      } catch {
        return { type: "ignore" };
      }
      const stage = typeof head.kind === "string" ? STAGE_KINDS[head.kind] : undefined;
      if (stage) {
        // Targeted by the server already; the identity check is belt and braces.
        if (typeof head.identity === "string" && head.identity !== identity) return { type: "ignore" };
        return { type: stage } as EdgeAction;
      }
      return { type: "packet", data };
    }
    default:
      return { type: "ignore" };
  }
}

/* What a refused event stream means (lib/edge-events.ts).
 *
 * EventSource cannot read a status, so when one closes the hook asks the same URL once with
 * fetch and classifies the answer here:
 *
 *   removed  403: the host removed this viewer. Terminal: no retry and no fresh join; the room
 *            says so. Retrying is how instant-webinar-4277 logged 181 refusals for one viewer,
 *            each pair followed by a join that handed out a new token for the next refusal.
 *   expired  401: the token is no good (expired, or the secret changed). Join again for a new
 *            one — as an automatic join, which the server refuses for a removed viewer.
 *   retry    anything else, a network failure included: try the stream again, backing off.
 */
export type EdgeStreamFailure = "removed" | "expired" | "retry";

export function edgeStreamFailure(status: number | null): EdgeStreamFailure {
  if (status === 403) return "removed";
  if (status === 401) return "expired";
  return "retry";
}

/** Base and ceiling of the stream's backoff. */
export const EDGE_RETRY_BASE_MS = 2_000;
export const EDGE_RETRY_MAX_MS = 60_000;
/** Fresh joins in a row, with no stream opening between them, before the hook stops asking
 *  for another and only retries the stream (still backing off). */
export const EDGE_MAX_REFRESHES = 3;

/** Delay before retry number `attempt` (1-based): doubling from the base, capped, less up to
 *  a quarter of jitter so an audience that dropped together does not come back together.
 *  `rand` is Math.random, injectable for the tests. */
export function edgeRetryDelay(attempt: number, rand: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(EDGE_RETRY_MAX_MS, EDGE_RETRY_BASE_MS * 2 ** Math.min(n - 1, 16));
  return Math.round(base * (0.75 + 0.25 * rand()));
}
