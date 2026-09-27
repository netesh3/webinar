/* The Engagement tab's Export menu: which downloads it offers and what each one is for.
 *
 * Two CSVs on purpose. The engagement CSV is one row per person (score, tier, watch time,
 * counts). The attendance CSV is the old Report export, kept byte-for-byte on its own
 * endpoint, because its shape is different — section rows, absolute timestamps, one row per
 * rejoin, hosts and panelists, every question — and spreadsheets people built on it would
 * break if it quietly became the other one. Pure so node can test it. */

export type ExportId = "engagement_csv" | "attendance_csv" | "chat_csv" | "transcript_txt";

export interface ExportUrls {
  engagementCsv?: string;
  attendanceCsv?: string;
  chatCsv?: string;
  transcriptTxt?: string;
}

export interface ExportOption {
  id: ExportId;
  label: string;
  hint: string;
  href: string;
}

/** Columns of each CSV, as the server writes them (api/internal/api). Documentation that a
 *  test keeps honest: if one side changes, the menu hint has to be re-read. */
export const ENGAGEMENT_CSV_COLUMNS = [
  "name", "email", "attended", "score", "tier", "watch_minutes", "join_timing",
  "first_join_min", "last_leave_min", "visits", "chats", "questions", "upvotes",
  "polls_answered", "polls_present", "quiz_correct", "quiz_answered", "reactions", "hand_raises",
] as const;

export const ATTENDANCE_CSV_COLUMNS = [
  "section", "name", "email", "role",
  "joined_at", "left_at", "minutes", "visits",
  "question", "answered",
] as const;

/** Columns only the legacy attendance CSV has — the reason it is still offered. */
export function legacyOnlyColumns(): string[] {
  const eng = new Set<string>(ENGAGEMENT_CSV_COLUMNS);
  return ATTENDANCE_CSV_COLUMNS.filter((c) => !eng.has(c));
}

const OPTIONS: { id: ExportId; url: keyof ExportUrls; label: string; hint: string; needsStart: boolean }[] = [
  {
    id: "engagement_csv",
    url: "engagementCsv",
    label: "Engagement (CSV)",
    hint: "One row per person: score, level, watch time, chats, questions, polls",
    needsStart: false,
  },
  {
    id: "attendance_csv",
    url: "attendanceCsv",
    label: "Attendance log (CSV)",
    hint: "The old Report export: every visit with join/leave times, hosts, questions",
    needsStart: true,
  },
  {
    id: "chat_csv",
    url: "chatCsv",
    label: "Chat log (CSV)",
    hint: "Every chat message, including panelists-only",
    needsStart: true,
  },
  {
    id: "transcript_txt",
    url: "transcriptTxt",
    label: "Captions transcript (TXT)",
    hint: "What was said, from live captions",
    needsStart: true,
  },
];

/** Sample data has nothing to download; before the start only the engagement CSV (the
 *  registrant list with empty scores) means anything. */
export function exportOptions(
  urls: ExportUrls,
  { started, sample = false }: { started: boolean; sample?: boolean },
): ExportOption[] {
  if (sample) return [];
  return OPTIONS.flatMap((o) => {
    const href = urls[o.url];
    if (!href || (o.needsStart && !started)) return [];
    return [{ id: o.id, label: o.label, hint: o.hint, href }];
  });
}
