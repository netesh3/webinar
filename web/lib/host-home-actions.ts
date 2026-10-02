import { FeatureInstantWebinar } from "./api-types.ts";

/* Which create cards the host Webinars page shows across the top.
 *
 * Schedule is always there. Instant is the second card only when this
 * account's instant_webinar switch is on. Being an admin does not count:
 * another admin without the switch sees Schedule alone in the left column,
 * the same width as when Instant sits beside it, with no locked placeholder. */

export type HostHomeAction = "schedule" | "instant";

/** Schedule first, then Instant when the flag is on.
 *
 *  That order is the columns: Schedule on the left, Instant on the right.
 *  On a narrow screen the same order stacks, Schedule on top. */
export function hostHomeCreateActions(
  features: readonly string[] | null | undefined,
): HostHomeAction[] {
  if ((features ?? []).includes(FeatureInstantWebinar)) {
    return ["schedule", "instant"];
  }
  return ["schedule"];
}

/** Always 2. Schedule keeps the left column when Instant is off.
 *
 *  The page is one column below sm, so Schedule is full width there either
 *  way. The right column stays empty when Instant is off. The action list
 *  still decides whether Instant is drawn; it does not decide the width. */
export function hostHomeCreateColumns(
  actions: readonly HostHomeAction[],
): 1 | 2 {
  // Callers still pass the card list. Width no longer reads it.
  void actions;
  return 2;
}
