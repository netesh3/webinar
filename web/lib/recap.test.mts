/* The AI recap's pure half: chapter times, mapping chapters onto a recording, and what the
 * card says with no recap.
 *
 * Run: node --experimental-strip-types --no-warnings lib/recap.test.mts */

import assert from "node:assert/strict";
import {
  actionItemsText,
  chapterAt,
  chapterSeekTimes,
  formatChapterTime,
  recapCanGenerateNow,
  recapEmptyState,
  recapSourceLabel,
} from "./recap.ts";

// formatChapterTime
assert.equal(formatChapterTime(0), "0:00");
assert.equal(formatChapterTime(65), "1:05");
assert.equal(formatChapterTime(3725), "1:02:05");
assert.equal(formatChapterTime(-3), "0:00");
assert.equal(formatChapterTime(Number.NaN), "0:00");

const chapters = [
  { startSec: 600, title: "Q&A" },
  { startSec: 0, title: "Welcome" },
  { startSec: 120, title: "Budgets" },
];
const start = "2026-10-22T10:00:00Z";

// One take pressed at go-live: chapters seek to the same second, in order.
assert.deepEqual(
  chapterSeekTimes(chapters, start, [{ createdAt: start, durationMs: 3_600_000 }]).map((c) => [c.title, c.startSec]),
  [["Welcome", 0], ["Budgets", 120], ["Q&A", 600]],
);

// Recording started 60s late: everything shifts; Welcome (before it) lands at 0.
assert.deepEqual(
  chapterSeekTimes(chapters, start, [{ createdAt: "2026-10-22T10:01:00Z", durationMs: 3_600_000 }]).map((c) => [
    c.title,
    c.startSec,
  ]),
  [["Welcome", 0], ["Budgets", 60], ["Q&A", 540]],
);

// Started 3 minutes late: Welcome and Budgets both land at 0 — the later one wins.
assert.deepEqual(
  chapterSeekTimes(chapters, start, [{ createdAt: "2026-10-22T10:03:00Z", durationMs: 3_600_000 }]).map((c) => [
    c.title,
    c.startSec,
  ]),
  [["Budgets", 0], ["Q&A", 420]],
);

// Two takes with a gap: [0, 300) then [500, 900) of the session, played back to back.
const takes = [
  { createdAt: start, durationMs: 300_000 },
  { createdAt: "2026-10-22T10:08:20Z", durationMs: 400_000 },
];
assert.deepEqual(
  chapterSeekTimes(
    [
      { startSec: 0, title: "A" },
      { startSec: 250, title: "B" },
      { startSec: 400, title: "In the gap" },
      { startSec: 700, title: "C" },
      { startSec: 1000, title: "After the end" },
    ],
    start,
    takes,
  ).map((c) => [c.title, c.startSec]),
  [["A", 0], ["B", 250], ["In the gap", 300], ["C", 500]],
);

// Recording started 90s before go-live: the session's 0:00 is 90s into it.
assert.deepEqual(
  chapterSeekTimes(chapters, start, [{ createdAt: "2026-10-22T09:58:30Z", durationMs: 3_600_000 }]).map((c) => [
    c.title,
    c.startSec,
  ]),
  [["Welcome", 90], ["Budgets", 210], ["Q&A", 690]],
);

// A real one (instant-webinar-0375): live 12:13:25, Record pressed 12:18:17 for 319.6s, ended
// 12:24:03. The chapters before the take collapse onto 0:00; the ones inside it keep their place.
assert.deepEqual(
  chapterSeekTimes(
    [
      { startSec: 0, title: "Welcome" },
      { startSec: 150, title: "Setup" },
      { startSec: 330, title: "Demo" },
      { startSec: 520, title: "Questions" },
      { startSec: 630, title: "After the take" },
    ],
    "2026-10-22T12:13:25Z",
    [{ createdAt: "2026-10-22T12:18:17Z", durationMs: 319_641 }],
  ).map((c) => [c.title, c.startSec]),
  [["Setup", 0], ["Demo", 38], ["Questions", 228]],
);

// No session start or no take times: the recording is taken to start with the session.
assert.deepEqual(
  chapterSeekTimes(chapters, undefined, [{ createdAt: "", durationMs: 200_000 }]).map((c) => c.startSec),
  [0, 120],
);
assert.deepEqual(chapterSeekTimes([], start, takes), []);
assert.deepEqual(chapterSeekTimes(chapters, start, []), []);

// chapterAt
const placed = [
  { title: "a", startSec: 0, sessionSec: 0 },
  { title: "b", startSec: 100, sessionSec: 100 },
];
assert.equal(chapterAt(placed, 0), 0);
assert.equal(chapterAt(placed, 99), 0);
assert.equal(chapterAt(placed, 100), 1);
assert.equal(chapterAt([{ title: "late", startSec: 10, sessionSec: 10 }], 5), -1);

// actionItemsText
assert.equal(
  actionItemsText([
    { text: "Share the slides", owner: "host" },
    { text: "Try the split", owner: "attendee" },
    { text: "Decide the date", owner: "unassigned" },
  ]),
  "- Share the slides (you)\n- Try the split (attendees)\n- Decide the date",
);

// recapEmptyState
assert.equal(recapEmptyState({ status: "ready", recap: { summary: "s" } as never }), null);
assert.equal(recapEmptyState({ status: "none", reason: "not_ended" })?.pending, false);
assert.match(recapEmptyState({ status: "pending", reason: "waiting_transcript" })!.title, /Still processing/);
assert.equal(recapEmptyState({ status: "pending", reason: "processing" })?.pending, true);
assert.match(recapEmptyState({ status: "skipped", reason: "ai_off" })!.title, /switched off/);
assert.match(recapEmptyState({ status: "skipped", reason: "ai_limit" })!.title, /limit/);
assert.match(recapEmptyState({ status: "skipped", reason: "empty" })!.title, /Nothing to recap/);
assert.match(recapEmptyState({ status: "skipped", reason: "ai_session_off" })!.title, /AI was off for this session/);
assert.match(recapEmptyState({ status: "failed", reason: "ai_unavailable" })!.title, /couldn't be written/);
// The recap is automatic: no state tells the host to generate or regenerate one.
for (const reason of ["not_ended", "waiting_transcript", "ai_off", "ai_session_off", "ai_limit", "empty", "ai_unavailable", "failed", undefined]) {
  for (const status of ["none", "pending", "skipped", "failed"]) {
    const st = recapEmptyState({ status, reason } as never)!;
    assert.doesNotMatch(st.title + " " + st.detail, /regenerat|generate/i, `${status}/${reason}`);
    assert.equal("canGenerate" in st, false);
  }
}

assert.match(recapEmptyState({ status: "skipped", reason: "transcript_unavailable" })!.title, /No transcript/);
// "Generate recap now" is offered only while the recap waits for the transcript.
assert.equal(recapCanGenerateNow({ status: "pending", reason: "waiting_transcript" }), true);
assert.equal(recapCanGenerateNow({ status: "pending", reason: "processing" }), false);
assert.equal(recapCanGenerateNow({ status: "ready", recap: { summary: "s" } as never }), false);
assert.equal(recapCanGenerateNow({ status: "skipped", reason: "empty" }), false);

assert.match(recapSourceLabel("engagement_only"), /Q&A/);
assert.equal(recapSourceLabel(undefined), "");

console.log("recap: ok");
