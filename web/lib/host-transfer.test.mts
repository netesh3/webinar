/* Who the host may hand the session to from Leave: a co-host in the room, nobody else.
 *
 * Run: node --experimental-strip-types --no-warnings lib/host-transfer.test.mts
 */

import assert from "node:assert/strict";
import {
  eligibleHostCandidates,
  isEligibleHostCandidate,
  mergeHostCandidates,
  metadataCoHost,
} from "./host-transfer.ts";

const self = "user_host";

// A co-host, either kind of identity, muted or not.
assert.equal(isEligibleHostCandidate({ identity: "user_p", role: "panelist", coHost: true }, self), true);
assert.equal(
  isEligibleHostCandidate({ identity: "att_KEY", role: "panelist", coHost: true, canPublish: false }, self),
  true,
);
// A plain panelist, a promoted attendee who is not a co-host, the audience: not eligible.
assert.equal(isEligibleHostCandidate({ identity: "user_p", role: "panelist" }, self), false);
assert.equal(isEligibleHostCandidate({ identity: "att_KEY", role: "panelist", coHost: false }, self), false);
assert.equal(isEligibleHostCandidate({ identity: "att_KEY", role: "attendee", coHost: true }, self), false);
// Never the host themselves, another host connection, or something that is not a person.
assert.equal(isEligibleHostCandidate({ identity: self, role: "panelist", coHost: true }, self), false);
assert.equal(isEligibleHostCandidate({ identity: "att_ME", role: "host", coHost: true }, self), false);
assert.equal(isEligibleHostCandidate({ identity: "EG_rec", role: "panelist", coHost: true }, self), false);
assert.equal(isEligibleHostCandidate({ identity: "att_", role: "panelist", coHost: true }, self), false);

// Roster names win, each person once, a stale roster row is rescued by live metadata.
const merged = mergeHostCandidates(
  [
    { identity: "user_p", name: "From roster", role: "panelist", coHost: true },
    { identity: "att_G", name: "Guest", role: "panelist", coHost: false },
  ],
  [
    { identity: "user_p", name: "From SFU", role: "panelist", coHost: true },
    { identity: "att_G", name: "Guest", role: "panelist", coHost: true },
    { identity: "user_x", name: "Plain", role: "panelist", coHost: false },
  ],
  self,
);
assert.deepEqual(
  merged.map((p) => [p.identity, p.name]),
  [
    ["user_p", "From roster"],
    ["att_G", "Guest"],
  ],
);
assert.deepEqual(eligibleHostCandidates(null, self), []);
assert.equal(eligibleHostCandidates([{ identity: "user_q", role: "panelist", coHost: true }], self)[0].name, "Co-host");

// The coHost flag in LiveKit metadata.
assert.equal(metadataCoHost(JSON.stringify({ role: "panelist", coHost: true })), true);
assert.equal(metadataCoHost(JSON.stringify({ role: "panelist" })), false);
assert.equal(metadataCoHost("not json"), false);
assert.equal(metadataCoHost(undefined), false);

console.log("host-transfer: ok");
