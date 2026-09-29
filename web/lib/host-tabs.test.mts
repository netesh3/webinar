/* The host screen's tabs: three per stage, old ?tab= links, defaults.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import { allowedTab, defaultTab, engagementSection, stepFor, tabFromQuery, tabsFor } from "./host-tabs.ts";

// Three tabs before, Results added while live, three after (two without WhatsApp).
assert.deepEqual(tabsFor("draft"), ["Overview", "People", "Setup"]);
assert.deepEqual(tabsFor("scheduled", true), ["Overview", "People", "Setup"]);
assert.deepEqual(tabsFor("live"), ["Overview", "People", "Setup", "Results"]);
assert.deepEqual(tabsFor("ended", true), ["Results", "Follow up"]);
assert.deepEqual(tabsFor("ended"), ["Results"]);
assert.deepEqual(tabsFor("ended", false, true), ["Results", "Recording"]);
assert.deepEqual(tabsFor("ended", true, true), ["Results", "Follow up", "Recording"]);

// The step bar.
assert.equal(stepFor("draft"), "create");
assert.equal(stepFor("scheduled"), "invite");
assert.equal(stepFor("live"), "live");
assert.equal(stepFor("ended"), "follow");

// Every old spelling still lands somewhere sensible.
for (const q of ["report", "Report", " REPORT ", "engagement", "insights", "analytics"]) {
  assert.equal(tabFromQuery(q), "Results", q);
}
assert.equal(tabFromQuery("admit"), "People");
assert.equal(tabFromQuery("attendees"), "People");
assert.equal(tabFromQuery("share"), "Overview");
assert.equal(tabFromQuery("stage"), "Setup");
assert.equal(tabFromQuery("settings"), "Setup");
assert.equal(tabFromQuery("messages"), "Follow up");
assert.equal(tabFromQuery("recordings"), "Recording");
assert.equal(tabFromQuery("nope"), null);
assert.equal(tabFromQuery(""), null);
assert.equal(tabFromQuery(null), null);

// Before the end: admit opens People, messages opens Overview (its automatic timeline).
assert.equal(defaultTab("scheduled", { requested: "admit" }), "People");
assert.equal(defaultTab("scheduled", { requested: "messages" }), "Overview");
assert.equal(defaultTab("scheduled", {}), "Overview");
assert.equal(defaultTab("draft", { requested: "report" }), "Overview");
assert.equal(defaultTab("live", { requested: "report" }), "Results");

// After the end: attendees and survey open Results at their section; messages opens Follow up.
assert.equal(defaultTab("ended", {}), "Results");
assert.equal(defaultTab("ended", { requested: "attendees" }), "Results");
assert.equal(engagementSection("attendees", "ended"), "attendees");
assert.equal(engagementSection("survey", "ended"), "survey");
assert.equal(engagementSection("recordings", "ended"), undefined);
assert.equal(defaultTab("ended", { whatsapp: true, requested: "messages" }), "Follow up");
assert.equal(defaultTab("ended", { whatsapp: false, requested: "messages" }), "Results");
assert.equal(defaultTab("ended", { requested: "recordings" }), "Results");
assert.equal(defaultTab("ended", { cloudRecording: true, requested: "recordings" }), "Recording");
assert.equal(allowedTab(tabFromQuery("recordings"), "ended"), null);
assert.equal(allowedTab(tabFromQuery("recordings"), "ended", false, true), "Recording");
assert.equal(allowedTab(tabFromQuery("admit"), "ended"), "Results");
assert.equal(allowedTab(tabFromQuery("settings"), "ended"), null);

console.log("host-tabs: ok");
