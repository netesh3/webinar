/* When the "Maximum Meeting Length Reached" dialog may show.
 *
 * Run: node --experimental-strip-types --no-warnings lib/meeting-limit.test.mts
 *
 * Only for a session that ran to its limit — never for a host who pressed End, which every
 * ended session used to look like (2026-10-20). */

import assert from "node:assert/strict";
import { endedByLimit } from "./meeting-limit.ts";

const start = "2026-10-20T10:00:00Z";
const at = (min: number) => new Date(Date.parse(start) + min * 60_000).toISOString();
const base = { status: "ended", startedAt: start, maxDurationMin: 180 };

assert.equal(endedByLimit({ ...base, endedAt: at(42) }), false, "host ended it after 42 minutes");
assert.equal(endedByLimit({ ...base, endedAt: at(179.5) }), true, "the sweeper ended it at the limit");
assert.equal(endedByLimit({ ...base, endedAt: at(181) }), true, "a little past the limit");
assert.equal(endedByLimit({ ...base, endedAt: null }), false, "no end time yet: do not guess");
assert.equal(endedByLimit({ ...base, status: "live", endedAt: at(180) }), false, "still live");
assert.equal(endedByLimit({ ...base, maxDurationMin: null, endedAt: at(500) }), false, "no limit");

console.log("meeting-limit: ok");
