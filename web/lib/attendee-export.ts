/* The Results tab's attendee list export (GET /api/host/webinars/{slug}/attendees.csv).
 * Pure so node can test it. */

export type AttendeeScope = "attended" | "all";

export const ATTENDEE_SCOPES: { id: AttendeeScope; label: string }[] = [
  { id: "attended", label: "Attended only" },
  { id: "all", label: "All registrants" },
];

/** The fixed columns, as api/internal/api/attendee_export.go writes them. One column per
 *  registration question follows. */
export const ATTENDEE_CSV_COLUMNS = [
  "name", "email", "phone", "registered_at", "attended", "first_joined_at", "last_left_at",
  "total_minutes", "watch_percent", "joined_via", "questions_asked", "chat_messages",
  "polls_answered", "raised_hand",
] as const;

/** The path, scope in the query only when it is not the server's default. */
export function attendeesCsvPath(slug: string, scope: AttendeeScope): string {
  const base = `/api/host/webinars/${encodeURIComponent(slug)}/attendees.csv`;
  return scope === "all" ? `${base}?scope=all` : base;
}
