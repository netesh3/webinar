/* The delivery an instant webinar starts with (docs/edge-delivery.md). An instant start has no form, so the choice sits next to the
 * button and the host's last pick is remembered in this browser. Anything unreadable
 * falls back to standard: a stored value is a preference, never a reason to go edge. */

import type { DeliveryOffer } from "./delivery-policy";

export type InstantDelivery = "standard" | "edge";

export const INSTANT_DELIVERY_KEY = "webcast.instantDelivery";

export function parseInstantDelivery(raw: string | null | undefined): InstantDelivery {
  return raw === "edge" ? "edge" : "standard";
}

/** What the create request sends: edge for a host an admin put on edge (on a GCP or DO
 *  video server, lib/delivery-policy.ts), the host's pick where they have the choice, else
 *  standard. On GCP and DO the server applies the admin's rule whatever this sends. */
export function instantDeliveryFor(
  choice: InstantDelivery,
  offer: DeliveryOffer,
): InstantDelivery {
  if (offer === "edge-only") return "edge";
  return offer === "choice" && choice === "edge" ? "edge" : "standard";
}

export function readInstantDelivery(): InstantDelivery {
  try {
    return parseInstantDelivery(window.localStorage.getItem(INSTANT_DELIVERY_KEY));
  } catch {
    return "standard";
  }
}

export function saveInstantDelivery(choice: InstantDelivery): void {
  try {
    window.localStorage.setItem(INSTANT_DELIVERY_KEY, choice);
  } catch {
    // Private mode or storage full: the choice still applies to this start.
  }
}
