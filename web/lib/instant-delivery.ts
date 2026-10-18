/* The delivery an instant webinar starts with, for hosts who have Edge delivery
 * (docs/edge-delivery.md). An instant start has no form, so the choice sits next to the
 * button and the host's last pick is remembered in this browser. Anything unreadable
 * falls back to standard: a stored value is a preference, never a reason to go edge. */

export type InstantDelivery = "standard" | "edge";

export const INSTANT_DELIVERY_KEY = "webcast.instantDelivery";

export function parseInstantDelivery(raw: string | null | undefined): InstantDelivery {
  return raw === "edge" ? "edge" : "standard";
}

/** What the create request sends: edge only when the host may use it and chose it. */
export function instantDeliveryFor(
  choice: InstantDelivery,
  edgeAllowed: boolean,
): InstantDelivery {
  return edgeAllowed && choice === "edge" ? "edge" : "standard";
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
