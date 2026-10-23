/* Which host surfaces the account's switches allow.
 *
 * Run: node --experimental-strip-types --no-warnings lib/host-features.test.mts */

import assert from "node:assert/strict";
import {
  followupSendOffered,
  hasFeature,
  instantOffered,
  meetingsOffered,
  simuliveAllowed,
  simuliveCardOffered,
} from "./host-features.ts";

assert.equal(hasFeature(null, "ai"), false);
assert.equal(hasFeature({ features: null }, "ai"), false);
assert.equal(hasFeature({ features: ["ai"] }, "ai"), true);

// The Webinars screen's Simulive card: cloud recording alone used to be enough. Not any more.
assert.equal(simuliveCardOffered({ features: ["cloud_recording"] }), false);
assert.equal(simuliveCardOffered({ features: ["simulive"] }), false);
assert.equal(simuliveCardOffered({ features: ["simulive", "cloud_recording"] }), true);
assert.equal(simuliveAllowed({ features: ["cloud_recording"] }), false);
assert.equal(simuliveAllowed({ features: ["simulive"] }), true);

// Meetings are on by default (every plan includes them); an admin turning them off hides them.
assert.equal(meetingsOffered({ features: ["meetings", "whiteboard"] }), true);
assert.equal(meetingsOffered({ features: ["whiteboard"] }), false);

// Instant meetings and webinars: an admin's per-host switch, off by default.
assert.equal(instantOffered({ features: ["meetings"] }), false);
assert.equal(instantOffered({ features: ["meetings", "instant_webinar"] }), true);

assert.equal(followupSendOffered({ features: ["ai", "followup_send"] }), true);
assert.equal(followupSendOffered({ features: ["ai"] }), false);

console.log("host-features: ok");
