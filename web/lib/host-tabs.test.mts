/* The host screen's tabs: old ?tab=report links, which statuses get Engagement, defaults.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import { allowedTab, defaultTab, tabFromQuery, tabsFor } from "./host-tabs.ts";

// Every old spelling of the Report tab lands on Engagement.
for (const q of ["report", "Report", " REPORT ", "engagement", "insights", "analytics"]) {
  assert.equal(tabFromQuery(q), "Engagement", q);
}
assert.equal(tabFromQuery("registrants"), "Admit");
assert.equal(tabFromQuery("attendance"), "Attendees");
assert.equal(tabFromQuery("nope"), null);

// ?tab=survey (and the older "feedback") open the Survey tab, before and after the event.
assert.equal(tabFromQuery("survey"), "Survey");
assert.equal(tabFromQuery("Feedback"), "Survey");
for (const s of ["draft", "scheduled", "live", "ended"]) {
  assert.equal(allowedTab(tabFromQuery("survey"), s), "Survey", s);
}
assert.equal(defaultTab("ended", { pending: 0, requested: "survey" }), "Survey");
assert.equal(tabFromQuery(""), null);
assert.equal(tabFromQuery(null), null);

// No tab is called Report any more.
for (const s of ["draft", "scheduled", "live", "ended"]) {
  assert.ok(!(tabsFor(s) as readonly string[]).includes("Report"), s);
}

// Ended leads with Engagement; live and scheduled offer it last; a draft does not.
assert.deepEqual(tabsFor("ended"), ["Engagement", "Recordings", "Attendees", "Survey"]);
assert.equal(tabsFor("live").at(-1), "Engagement");
assert.equal(tabsFor("scheduled").at(-1), "Engagement");
assert.ok(!tabsFor("draft").includes("Engagement"));

// Messages sits right after Attendees wherever it is offered.
const withMsg = tabsFor("ended", true);
assert.equal(withMsg[withMsg.indexOf("Attendees") + 1], "Messages");
assert.equal(tabsFor("live", true)[2], "Messages");

// ?tab=report on an ended webinar opens Engagement; on a draft it falls back.
assert.equal(allowedTab(tabFromQuery("report"), "ended"), "Engagement");
assert.equal(allowedTab(tabFromQuery("report"), "draft"), null);
assert.equal(allowedTab(tabFromQuery("admit"), "ended"), null);

assert.equal(defaultTab("ended", { pending: 0 }), "Engagement");
assert.equal(defaultTab("ended", { pending: 0, requested: "recordings" }), "Recordings");
assert.equal(defaultTab("ended", { pending: 0, requested: "report" }), "Engagement");
assert.equal(defaultTab("ended", { pending: 0, requested: "admit" }), "Engagement");
assert.equal(defaultTab("scheduled", { pending: 3 }), "Admit");
assert.equal(defaultTab("scheduled", { pending: 0 }), "Attendees");
assert.equal(defaultTab("live", { pending: 0, requested: "report" }), "Engagement");
assert.equal(defaultTab("draft", { pending: 0, requested: "report" }), "Attendees");

console.log("host-tabs: ok");
