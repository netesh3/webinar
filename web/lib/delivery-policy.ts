/* What delivery the schedule form and the instant button offer (docs/edge-delivery.md).
 *
 * The server decides, from where the webinar's room is or will be (GET /api/host/delivery):
 * on a GCP or DigitalOcean video server (production) every webinar is edge and there is no
 * choice; on any other server with a live origin every host chooses Standard or Edge; without
 * one it is standard. Meetings, simulive sessions and Zoom are always standard. The server applies
 * the same rule on every save, so this only decides what to show and what to send. */

import type { DeliveryPolicy } from "./api-types";

/** "edge-only": a note, no choice. "choice": Standard / Edge. "none": nothing to show. */
export type DeliveryOffer = "edge-only" | "choice" | "none";

export type DeliveryShape = {
  /** The form's kind: live, recurring, simulive or meeting. */
  kind: string;
  /** "app" or a Zoom venue. */
  venue: string;
};

// A webinar, one-off or a series, that runs in this app: the only shape that can be edge.
export function edgeFits(shape: DeliveryShape): boolean {
  return shape.kind !== "meeting" && shape.kind !== "simulive" && shape.venue === "app";
}

export function deliveryOffer(
  policy: DeliveryPolicy | null | undefined,
  shape: DeliveryShape,
): DeliveryOffer {
  if (!policy || !edgeFits(shape)) return "none";
  if (policy.edgeOnly) return "edge-only";
  return policy.edgeChoice ? "choice" : "none";
}

/** The `delivery` a save sends. Undefined (omit the field, the server keeps what is saved)
 *  until the policy is known, and for a host who has nothing to choose. */
export function deliveryToSend(
  policy: DeliveryPolicy | null | undefined,
  shape: DeliveryShape,
  chosen: "standard" | "edge",
): "standard" | "edge" | undefined {
  if (!policy || (!policy.edgeOnly && !policy.edgeChoice)) return undefined;
  switch (deliveryOffer(policy, shape)) {
    case "edge-only":
      return "edge";
    case "choice":
      return chosen;
    default:
      return "standard";
  }
}

/** The line shown instead of a choice where every webinar is edge. */
export const EDGE_ONLY_NOTE = "Your audience watches a low-latency stream; speakers join live.";
