/* Where the host goes after a webinar ends.
 *
 * Run: node --experimental-strip-types --no-warnings lib/host-results.test.mts
 */
import assert from "node:assert/strict";
import { afterWebinarEnd, hostResultsPath } from "./host-results.ts";
import { tabFromQuery } from "./host-tabs.ts";

const slug = "final-testing-all-flow-new";
const href = hostResultsPath(slug);

assert.equal(href, "/host/final-testing-all-flow-new?tab=results");
assert.equal(
  tabFromQuery(new URL(`https://webinarliv.com${href}`).searchParams.get("tab")),
  "Results",
);

// An instant webinar has the same host page.
assert.equal(hostResultsPath("instant-abc"), "/host/instant-abc?tab=results");
// One path segment, even when the slug is not already URL-safe.
assert.equal(hostResultsPath("a b/c"), "/host/a%20b%2Fc?tab=results");

// Ended from the duration limit, another device, or the sweeper.
assert.deepEqual(
  afterWebinarEnd({ role: "host", ended: true, ownEndPending: false, slug }),
  { go: "results", href },
);

// This browser pressed End. Stay until that request returns: it also sends the survey.
assert.deepEqual(
  afterWebinarEnd({ role: "host", ended: true, ownEndPending: true, slug }),
  { go: "stay" },
);

// End failed, or they only left. The session is not over.
assert.deepEqual(
  afterWebinarEnd({ role: "host", ended: false, ownEndPending: false, slug }),
  { go: "stay" },
);
assert.deepEqual(
  afterWebinarEnd({ role: "host", ended: false, ownEndPending: true, slug }),
  { go: "stay" },
);

// Attendees and panelists keep the ended screen. A co-host's role is panelist.
for (const role of ["attendee", "panelist"]) {
  assert.deepEqual(
    afterWebinarEnd({ role, ended: true, ownEndPending: false, slug }),
    { go: "ended-screen" },
    role,
  );
}

// A co-host who pressed End stays in the room until that request returns.
assert.deepEqual(
  afterWebinarEnd({ role: "panelist", ended: true, ownEndPending: true, slug }),
  { go: "stay" },
);

console.log("host-results: ok");
