/* Tests for scheduling a simulive from a recording: which recordings are offered, the length,
 * and what the schedule form is prefilled with. Run with `make test-web`. */

import assert from "node:assert/strict";
import type { Recording } from "./api-types.ts";
import {
  eligibleRecordings,
  simuliveDurationMin,
  simuliveEligible,
  simulivePrefill,
  simuliveScheduleHref,
  switchRecording,
} from "./simulive-create.ts";

function rec(over: Partial<Recording>): Recording {
  return {
    id: "rec-1",
    webinar: "original-session",
    topic: "Original session",
    status: "ready",
    mime: "video/mp4",
    sizeBytes: 1000,
    durationMs: 45 * 60_000,
    startedBy: "Coach Asha",
    createdAt: "2026-10-01T10:00:00Z",
    ext: "mp4",
    isPublic: false,
    passcodeRequired: false,
    uploadedToS3: true,
    uploadPercent: 100,
    retentionDays: 0,
    ...over,
  };
}

// Eligibility: ready with a stored file, nothing else.
assert.equal(simuliveEligible(rec({})), true);
assert.equal(simuliveEligible(rec({ status: "processing" })), false);
assert.equal(simuliveEligible(rec({ status: "recording" })), false);
assert.equal(simuliveEligible(rec({ status: "failed" })), false);
// "Ready" before the egress has uploaded the bytes is still in flight.
assert.equal(simuliveEligible(rec({ sizeBytes: 0 })), false);
assert.deepEqual(
  eligibleRecordings([
    rec({ id: "a" }),
    rec({ id: "b", status: "processing" }),
    rec({ id: "c", status: "failed" }),
    rec({ id: "d", sizeBytes: 0 }),
    rec({ id: "e" }),
  ]).map((r) => r.id),
  ["a", "e"],
);

// Length: whole minutes, rounded up, within 1..1440.
assert.equal(simuliveDurationMin(45 * 60_000), 45);
assert.equal(simuliveDurationMin(45 * 60_000 + 1), 46);
assert.equal(simuliveDurationMin(10_000), 1);
assert.equal(simuliveDurationMin(0), 1);
assert.equal(simuliveDurationMin(Number.NaN), 1);
assert.equal(simuliveDurationMin(30 * 3600_000), 1440);

assert.equal(simuliveScheduleHref(rec({ id: "a b" })), "/host/new?simulive=a%20b");

// Prefill from the recording alone, then with the original webinar read.
assert.deepEqual(simulivePrefill(rec({ topic: "  Original session " })), {
  kind: "simulive",
  simuliveRecordingId: "rec-1",
  topic: "Original session",
  summary: "",
  description: "",
  track: "",
  durationMin: 45,
  venue: "app",
  delivery: "standard",
});
const withSource = simulivePrefill(rec({}), {
  topic: "Scaling WebRTC",
  summary: "One line",
  description: "The full story",
  track: "Engineering",
});
assert.equal(withSource.topic, "Scaling WebRTC");
assert.equal(withSource.summary, "One line");
assert.equal(withSource.description, "The full story");
assert.equal(withSource.track, "Engineering");
assert.equal(withSource.durationMin, 45);

// Changing the recording: length follows; the title only while it is the old recording's.
const a = rec({ id: "a", topic: "Session A", durationMs: 20 * 60_000 });
const b = rec({ id: "b", topic: "Session B", durationMs: 61 * 60_000 });
assert.deepEqual(switchRecording({ topic: "Session A" }, a, b), {
  simuliveRecordingId: "b",
  durationMin: 61,
  topic: "Session B",
});
assert.equal(switchRecording({ topic: "My encore" }, a, b).topic, "My encore");
assert.equal(switchRecording({ topic: "" }, null, b).topic, "Session B");

console.log("simulive-create: ok");
