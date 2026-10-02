import { FeatureInstantWebinar } from "./api-types.ts";

/* Which create cards the host Webinars page shows across the top.
 *
 * Schedule is always there. Instant is the second card only when this
 * account's instant_webinar switch is on. Being an admin does not count:
 * another admin without the switch sees Schedule alone, full width, with no
 * locked placeholder. */

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

/** 2 when both cards show, 1 when Schedule is alone and should span the row. */
export function hostHomeCreateColumns(
  actions: readonly HostHomeAction[],
): 1 | 2 {
  return actions.includes("instant") ? 2 : 1;
}
