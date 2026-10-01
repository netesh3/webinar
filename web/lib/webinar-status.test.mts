/* A scheduled webinar that never went live leaves Upcoming once its end passes.
 *
 * Run: node --experimental-strip-types --no-warnings lib/webinar-status.test.mts
 */

import assert from "node:assert/strict";
import { lapsedWithoutLive, presentForHostList, scheduledEndMs } from "./webinar-status.ts";

const NOW = Date.parse("2026-10-01T10:36:00.000Z"); // 16:06 IST

function row(
  partial: Partial<{
    status: string;
    startedAt?: string;
    startsAt: string;
    durationMin: number;
    didntGoLive?: boolean;
  }>,
) {
  return {
    status: "scheduled",
    startsAt: "2026-09-30T06:00:00.000Z", // 11:30 IST
    durationMin: 60,
    ...partial,
  };
}

assert.equal(scheduledEndMs("2026-09-30T06:00:00.000Z", 60), Date.parse("2026-09-30T07:00:00.000Z"));
assert.equal(scheduledEndMs("not-a-time", 60), null);

// Yesterday, never started: completed.
assert.equal(lapsedWithoutLive(row({}), NOW), true);
const missed = presentForHostList(row({}), NOW);
assert.equal(missed.status, "ended");
assert.equal(missed.didntGoLive, true);

// Still in the future: upcoming.
const futureStart = new Date(NOW + 2 * 60 * 60_000).toISOString();
assert.equal(lapsedWithoutLive(row({ startsAt: futureStart }), NOW), false);
assert.equal(presentForHostList(row({ startsAt: futureStart }), NOW).status, "scheduled");

// Started, and the scheduled end has passed, but it is live: stays live.
const live = presentForHostList(
  row({ status: "live", startedAt: "2026-09-30T06:00:00.000Z" }),
  NOW,
);
assert.equal(live.status, "live");
assert.equal(live.didntGoLive, undefined);

// A draft whose start is in the past is still a draft.
const draft = presentForHostList(row({ status: "draft" }), NOW);
assert.equal(draft.status, "draft");
assert.equal(draft.didntGoLive, undefined);

// A session that ran does not pick up the tag.
const ran = presentForHostList(
  row({ status: "ended", startedAt: "2026-09-30T06:00:00.000Z" }),
  NOW,
);
assert.equal(ran.status, "ended");
assert.equal(ran.didntGoLive, undefined);

// The server already said so.
assert.equal(lapsedWithoutLive(row({ status: "ended", didntGoLive: true }), NOW), true);

console.log("webinar-status: ok");
