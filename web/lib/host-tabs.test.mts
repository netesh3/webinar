/* The host screen's tabs: old ?tab=report links, which statuses get Engagement, defaults.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import { allowedTab, defaultTab, engagementSection, tabFromQuery, tabsFor } from "./host-tabs.ts";

// Every old spelling of the Report tab lands on Engagement.
for (const q of ["report", "Report", " REPORT ", "engagement", "insights", "analytics"]) {
  assert.equal(tabFromQuery(q), "Engagement", q);
}
assert.equal(tabFromQuery("registrants"), "Admit");
assert.equal(tabFromQuery("attendance"), "Attendees");
assert.equal(tabFromQuery("nope"), null);

// ?tab=survey (and the older "feedback") and ?tab=attendees name tabs an ended webinar folded
// into Engagement: they open Engagement at the matching section.
assert.equal(tabFromQuery("survey"), "Survey");
assert.equal(tabFromQuery("Feedback"), "Survey");
assert.equal(allowedTab(tabFromQuery("survey"), "ended"), "Engagement");
assert.equal(allowedTab(tabFromQuery("attendees"), "ended"), "Engagement");
assert.equal(engagementSection("survey", "ended"), "survey");
assert.equal(engagementSection("attendance", "ended"), "attendees");
assert.equal(engagementSection("recordings", "ended"), undefined);
assert.equal(defaultTab("ended", { pending: 0, requested: "survey" }), "Engagement");
assert.equal(defaultTab("ended", { pending: 0, requested: "attendees" }), "Engagement");
// Before the end Attendees is the registrant list, a tab of its own.
assert.equal(allowedTab(tabFromQuery("attendees"), "scheduled"), "Attendees");
assert.equal(engagementSection("attendees", "scheduled"), undefined);
// The survey is set up in the schedule form, so a draft has nowhere to open it.
assert.equal(allowedTab(tabFromQuery("survey"), "draft"), null);
assert.equal(engagementSection("survey", "live"), "survey");
assert.equal(tabFromQuery(""), null);
assert.equal(tabFromQuery(null), null);

// No tab is called Report any more.
for (const s of ["draft", "scheduled", "live", "ended"]) {
  assert.ok(!(tabsFor(s) as readonly string[]).includes("Report"), s);
}

// Ended leads with Engagement; live and scheduled offer it last; a draft does not.
assert.deepEqual(tabsFor("ended"), ["Engagement", "Recordings"]);
for (const s of ["draft", "scheduled", "live", "ended"]) {
  assert.ok(!tabsFor(s).includes("Survey"), s);
}
assert.ok(!tabsFor("ended").includes("Attendees"));
assert.equal(tabsFor("live").at(-1), "Engagement");
assert.equal(tabsFor("scheduled").at(-1), "Engagement");
assert.ok(!tabsFor("draft").includes("Engagement"));

// Messages sits right after Attendees, or after Engagement once Attendees is gone.
assert.deepEqual(tabsFor("ended", true), ["Engagement", "Messages", "Recordings"]);
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
