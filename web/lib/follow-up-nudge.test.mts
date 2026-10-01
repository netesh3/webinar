/* The host-home follow-up column: a week after the end, and no wider.
 *
 * Run: node --experimental-strip-types --no-warnings lib/follow-up-nudge.test.mts
 */

import assert from "node:assert/strict";
import {
  FOLLOW_UP_FETCH_LIMIT,
  FOLLOW_UP_VISIBLE,
  FOLLOW_UP_WINDOW_MS,
  eligibleFollowUps,
  followUpListCacheKey,
  withinFollowUpWindow,
} from "./follow-up-nudge.ts";

const WEEK = 7 * 24 * 3_600_000;
const NOW = Date.parse("2026-10-01T12:00:00.000Z");

assert.equal(FOLLOW_UP_WINDOW_MS, WEEK);
assert.equal(FOLLOW_UP_VISIBLE, 5);
assert.equal(FOLLOW_UP_FETCH_LIMIT, 100);
assert.equal(followUpListCacheKey("host-webinars:"), "host-webinars:tab=past&limit=100");

function at(msFromNow: number): string {
  return new Date(NOW + msFromNow).toISOString();
}

assert.equal(withinFollowUpWindow(undefined, NOW), false);
assert.equal(withinFollowUpWindow("", NOW), false);
assert.equal(withinFollowUpWindow("not-a-time", NOW), false);
assert.equal(withinFollowUpWindow(at(-WEEK + 1), NOW), true);
assert.equal(withinFollowUpWindow(at(-WEEK), NOW), false);
assert.equal(withinFollowUpWindow(at(-WEEK - 1), NOW), false);
assert.equal(withinFollowUpWindow(at(60_000), NOW), true);

const rows = [
  { id: "just-ended", endedAt: at(-3_600_000) },
  { id: "no-end" },
  { id: "last-week", endedAt: at(-14 * 24 * 3_600_000) },
  { id: "still-fresh", endedAt: at(-6 * 24 * 3_600_000) },
  { id: "unreadable", endedAt: "yesterday" },
];

assert.deepEqual(
  eligibleFollowUps(rows, NOW).map((w) => w.id),
  ["just-ended", "still-fresh"],
);

console.log("follow-up-nudge: ok");
