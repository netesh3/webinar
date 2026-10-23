/* The simulive form's recording preview: which chapters it shows.
 *
 * Run: node --experimental-strip-types --no-warnings lib/recording-preview.test.mts */

import assert from "node:assert/strict";
import { previewChapters } from "./recording-preview.ts";
import type { SessionRecapResponse } from "./api-types.ts";

const rec = {
  id: "r1",
  status: "ready",
  sizeBytes: 10,
  durationMs: 600_000,
  parts: undefined,
};
const start = "2026-01-01T10:00:00Z";
const recap = (r: object) => r as unknown as SessionRecapResponse;

// No recap at all (failed to load): no chapters, plainly.
assert.deepEqual(previewChapters(null, start, rec), {
  chapters: [],
  pending: false,
  empty: "No chapters yet",
});

// A ready recap with no chapters.
assert.equal(
  previewChapters(recap({ status: "ready", recap: { chapters: [] } }), start, rec).empty,
  "No chapters yet",
);

// Still being written: says so.
const pending = previewChapters(recap({ status: "pending" }), start, rec);
assert.equal(pending.pending, true);
assert.match(pending.empty ?? "", /still being written/);

// Chapters placed on the recording; one past its end is dropped.
const ready = previewChapters(
  recap({
    status: "ready",
    recap: {
      chapters: [
        { title: "Intro", startSec: 0 },
        { title: "Demo", startSec: 125 },
        { title: "After", startSec: 900 },
      ],
    },
  }),
  undefined,
  rec,
);
assert.equal(ready.empty, null);
assert.deepEqual(
  ready.chapters.map((c) => [c.title, c.startSec]),
  [
    ["Intro", 0],
    ["Demo", 125],
  ],
);

// A recording with nothing playable has nowhere to put chapters.
assert.equal(
  previewChapters(
    recap({
      status: "ready",
      recap: { chapters: [{ title: "Intro", startSec: 0 }] },
    }),
    start,
    { ...rec, sizeBytes: 0 },
  ).chapters.length,
  0,
);

console.log("recording-preview: ok");
