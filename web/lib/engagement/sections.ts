/* The Engagement tab's section ids, and the small pieces of arithmetic behind the
 * clock-time columns. Pure so node can test it. */

export type SectionId =
  | "overview"
  | "attendance"
  | "activity"
  | "attendees"
  | "chat"
  | "qa"
  | "polls"
  | "reactions"
  | "survey"
  | "follow-up";

export const sectionDomId = (id: SectionId) => `eng-${id}`;

/** Wall-clock ISO time `minute` minutes after the live start. Minute offsets are what the
 *  engagement rows carry; the old attendance table showed clock times, so this converts. */
export function clockAt(startedAt: string | undefined, minute: number): string | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return null;
  return new Date(t + minute * 60_000).toISOString();
}

export type LeaveState =
  | { kind: "still_in" }
  | { kind: "stayed" }
  | { kind: "left"; minute: number };

/** How a row's last departure reads. -1 is the server's "no departure recorded", which is
 *  "still in" while live and, after the end, somebody whose connection never said goodbye. */
export function leaveState(lastLeaveMin: number, sessionMin: number, live: boolean): LeaveState {
  if (lastLeaveMin < 0) return live ? { kind: "still_in" } : { kind: "stayed" };
  if (!live && lastLeaveMin >= sessionMin) return { kind: "stayed" };
  return { kind: "left", minute: lastLeaveMin };
}
