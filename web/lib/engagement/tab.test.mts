/* The Engagement tab's exports and section arithmetic. Run with `make test-web`. */

import assert from "node:assert/strict";
import {
  ATTENDANCE_CSV_COLUMNS,
  ENGAGEMENT_CSV_COLUMNS,
  exportOptions,
  legacyOnlyColumns,
} from "./exports.ts";
import { SECTIONS, activeSection, clockAt, leaveState, sectionDomId } from "./sections.ts";

const urls = {
  engagementCsv: "/e.csv",
  attendanceCsv: "/report.csv",
  chatCsv: "/chat?format=csv",
  transcriptTxt: "/t.txt",
};

// ---- exports

// After the start: all four, engagement first, the old Report CSV still there.
assert.deepEqual(
  exportOptions(urls, { started: true }).map((o) => o.id),
  ["engagement_csv", "attendance_csv", "chat_csv", "transcript_txt"],
);
assert.equal(exportOptions(urls, { started: true })[1].href, "/report.csv");
// Before the start only the registrant-shaped engagement CSV means anything.
assert.deepEqual(exportOptions(urls, { started: false }).map((o) => o.id), ["engagement_csv"]);
// Sample data downloads nothing.
assert.deepEqual(exportOptions(urls, { started: true, sample: true }), []);
// A missing URL drops its item rather than rendering a dead link.
assert.deepEqual(
  exportOptions({ engagementCsv: "/e.csv" }, { started: true }).map((o) => o.id),
  ["engagement_csv"],
);

// The legacy CSV is kept because it carries columns the engagement CSV does not. If this
// ever becomes empty, the attendance export can be retired.
assert.deepEqual(legacyOnlyColumns(), ["section", "role", "joined_at", "left_at", "minutes", "question", "answered"]);
assert.ok(ENGAGEMENT_CSV_COLUMNS.includes("visits") && ATTENDANCE_CSV_COLUMNS.includes("visits"));

// ---- sections

assert.deepEqual(
  SECTIONS.map((s) => s.label),
  ["Overview", "Attendance", "Activity", "Attendees", "Chat", "Q&A", "Polls & quizzes", "Reactions", "Survey", "Follow up"],
);
assert.equal(sectionDomId("qa"), "eng-qa");
assert.equal(new Set(SECTIONS.map((s) => s.id)).size, SECTIONS.length);

const tops = [
  { id: "overview" as const, top: -900 },
  { id: "attendance" as const, top: -100 },
  { id: "activity" as const, top: 400 },
];
assert.equal(activeSection(tops, 120), "attendance");
assert.equal(activeSection(tops, 500), "activity");
// Above the first section, the first is current rather than none.
assert.equal(activeSection([{ id: "overview", top: 300 }], 120), "overview");
assert.equal(activeSection([], 120), null);

// ---- clock times

assert.equal(clockAt("2026-09-08T09:30:00Z", 2), "2026-09-08T09:32:00.000Z");
assert.equal(clockAt("2026-09-08T09:30:00Z", -12), "2026-09-08T09:18:00.000Z");
assert.equal(clockAt(undefined, 5), null);
assert.equal(clockAt("not a date", 5), null);

assert.deepEqual(leaveState(-1, 60, true), { kind: "still_in" });
assert.deepEqual(leaveState(-1, 60, false), { kind: "stayed" });
assert.deepEqual(leaveState(60, 60, false), { kind: "stayed" });
assert.deepEqual(leaveState(44, 60, false), { kind: "left", minute: 44 });
assert.deepEqual(leaveState(30, 30, true), { kind: "left", minute: 30 });

console.log("engagement exports/sections: ok");
