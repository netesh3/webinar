/* Tests for the streaming viewer's tool filter and the header's meeting-info rule.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import type { ToolId } from "./tools.ts";
import {
  showsMeetingInfo,
  STREAMING_AUDIENCE_HIDDEN_TOOLS,
  streamingAudienceTools,
} from "./audience-tools.ts";

const attendee: ToolId[] = ["chat", "qa", "polls", "participants", "invite", "reactions", "hand", "settings", "sharefile"];

// A streaming viewer loses exactly participants, invite and settings, order kept.
assert.deepEqual(streamingAudienceTools(attendee, true), ["chat", "qa", "polls", "reactions", "hand", "sharefile"]);
for (const id of STREAMING_AUDIENCE_HIDDEN_TOOLS) {
  assert.ok(!streamingAudienceTools(attendee, true).includes(id), id);
}

// Everyone else is untouched, and gets a copy rather than the same array.
const same = streamingAudienceTools(attendee, false);
assert.deepEqual(same, attendee);
assert.notEqual(same, attendee);

// Engagement tools the host turned off are not brought back by the filter.
assert.deepEqual(streamingAudienceTools(["chat", "participants", "settings"], true), ["chat"]);
assert.deepEqual(streamingAudienceTools([], true), []);

// Meeting info: never for a streaming viewer, nor a plain WebRTC attendee.
const base = { isHost: false, canPublish: false, meeting: false, cdnStage: false };
assert.equal(showsMeetingInfo({ ...base, cdnStage: true }), false);
assert.equal(showsMeetingInfo(base), false);
// The stage keeps it: host, panelist (or a promoted attendee), and everyone in a meeting.
assert.equal(showsMeetingInfo({ ...base, isHost: true }), true);
assert.equal(showsMeetingInfo({ ...base, canPublish: true }), true);
assert.equal(showsMeetingInfo({ ...base, meeting: true }), true);

console.log("audience-tools ok");
