/* The Engagement tab's in-page sections, and the small pieces of arithmetic behind the
 * sticky nav and the clock-time columns. Pure so node can test it. */

export const SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "attendance", label: "Attendance" },
  { id: "activity", label: "Activity" },
  { id: "attendees", label: "Attendees" },
  { id: "chat", label: "Chat" },
  { id: "qa", label: "Q&A" },
  { id: "polls", label: "Polls & quizzes" },
  { id: "reactions", label: "Reactions" },
  { id: "survey", label: "Survey" },
  { id: "follow-up", label: "Follow up" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export const sectionDomId = (id: SectionId) => `eng-${id}`;

/** The section the reader is in: the last one whose top has scrolled above the reading
 *  line. Tops are viewport-relative (getBoundingClientRect().top), in section order. */
export function activeSection(
  tops: readonly { id: SectionId; top: number }[],
  readingLine: number,
): SectionId | null {
  let current: SectionId | null = tops[0]?.id ?? null;
  for (const t of tops) {
    if (t.top - readingLine <= 1) current = t.id;
    else break;
  }
  return current;
}

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
