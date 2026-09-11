/**
 * Eligibility for Leave → Assign host.
 *
 * Run: npx --yes tsx lib/host-transfer.selftest.ts
 */
import {
  eligibleHostCandidates,
  isEligibleHostCandidate,
  mergeHostCandidates,
} from "./host-transfer";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const self = "user_host";

assert(
  isEligibleHostCandidate(
    { identity: "user_panel", role: "panelist", canPublish: false },
    self,
  ),
  "muted panelist (role + no publish) must be eligible",
);

assert(
  !isEligibleHostCandidate(
    { identity: "att_promoted", role: "panelist", canPublish: true },
    self,
  ),
  "promoted attendee identity cannot own the webinar",
);

assert(
  !isEligibleHostCandidate(
    { identity: self, role: "host", canPublish: true },
    self,
  ),
  "host cannot hand off to self",
);

assert(
  isEligibleHostCandidate(
    { identity: "user_stage", role: "attendee", canPublish: true },
    self,
  ),
  "signed-in publisher with stale role still counts",
);

const merged = mergeHostCandidates(
  [
    {
      identity: "user_panel",
      name: "From roster",
      role: "panelist",
      canPublish: false,
    },
  ],
  [
    {
      identity: "user_panel",
      name: "From remotes",
      role: "panelist",
      canPublish: true,
    },
    {
      identity: "user_other",
      name: "Other",
      role: "panelist",
      canPublish: true,
    },
  ],
  self,
);

assert(merged.length === 2, `expected 2 candidates, got ${merged.length}`);
assert(
  merged[0]?.name === "From roster",
  "roster name should win when identities collide",
);

assert(
  eligibleHostCandidates(
    [{ identity: "user_panel", role: "panelist", canPublish: false }],
    self,
  ).length === 1,
  "eligibleHostCandidates should list muted panelists",
);

console.log("host-transfer.selftest: ok");
