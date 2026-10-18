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
