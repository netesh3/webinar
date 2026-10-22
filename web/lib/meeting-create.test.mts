/* The meeting create request, and the host screen's meeting tabs.
 *
 * Run: node --experimental-strip-types --no-warnings lib/meeting-create.test.mts
 */

import assert from "node:assert/strict";
import { instantMeetingInput, isMeetingKind, meetingInputBase } from "./meeting-create.ts";
import { allowedTab, defaultTab, meetingTabs, tabsFor } from "./host-tabs.ts";

// Instant: a meeting, now, with every audience setting at the one answer a meeting has.
const at = new Date("2026-10-22T10:00:00Z");
const instant = instantMeetingInput("Asia/Kolkata", at);
assert.equal(instant.kind, "meeting");
assert.equal(instant.instant, true);
assert.equal(instant.status, "scheduled");
assert.equal(instant.startsAt, at.toISOString());
assert.equal(instant.timeZone, "Asia/Kolkata");
assert.equal(instant.topic, "Meeting");
assert.equal(instant.registrationRequired, false);
assert.equal(instant.passcode, "");
assert.equal(instant.delivery, "standard");
assert.equal(instant.venue, "app");
assert.equal(instant.controls.hideAttendees, false);
// Entry muting is the pre-join screen's; the room must not undo a guest who unmuted there.
assert.equal(instant.controls.muteOnEntry, false);
assert.equal(instant.controls.allowUnmute, true);
assert.equal(instant.controls.raiseHandEnabled, false);
assert.equal(instant.options.raiseHand, false);
assert.equal(instant.options.practiceSession, false);
assert.equal(instant.options.emailReminders, false);
assert.equal(instant.recurrence, undefined);

// The base carries no topic or time of its own, so a scheduled create cannot inherit "now".
const base = meetingInputBase() as Record<string, unknown>;
assert.equal(base.topic, undefined);
assert.equal(base.startsAt, undefined);
assert.equal(base.instant, undefined);

assert.equal(isMeetingKind({ kind: "meeting" }), true);
assert.equal(isMeetingKind({ kind: "live" }), false);
assert.equal(isMeetingKind(null), false);

// A meeting has no People and no Follow up; everything else is the webinar's.
assert.deepEqual(meetingTabs(["Overview", "People", "Setup", "Results"]), ["Overview", "Setup", "Results"]);
assert.deepEqual(tabsFor("scheduled", true, true, true), ["Overview", "Setup"]);
assert.deepEqual(tabsFor("live", true, true, true), ["Overview", "Setup", "Results"]);
assert.deepEqual(tabsFor("ended", true, true, true), ["Results", "Recording"]);
assert.deepEqual(tabsFor("ended", true, false, true), ["Results"]);
// Webinars unchanged.
assert.deepEqual(tabsFor("scheduled", true, true), ["Overview", "People", "Setup"]);
assert.deepEqual(tabsFor("ended", true, true), ["Results", "Follow up", "Recording"]);

// Old links: People on a meeting opens Overview before the end and Results after it.
assert.equal(allowedTab("People", "scheduled", false, false, true), "Overview");
assert.equal(allowedTab("People", "ended", false, false, true), "Results");
assert.equal(allowedTab("Follow up", "ended", true, false, true), "Results");
assert.equal(allowedTab("People", "scheduled"), "People");
assert.equal(defaultTab("live", { requested: "people", meeting: true }), "Overview");
assert.equal(defaultTab("ended", { requested: "follow-up", whatsapp: true, meeting: true }), "Results");

console.log("meeting-create: ok");
