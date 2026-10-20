/* Admin account row: Instant webinar and the rest live in Features.
 *
 * Run: node --experimental-strip-types --no-warnings lib/admin-account-features.test.mts
 *
 * Order follows the server catalogue (Instant webinar before Zoom). A non-host does not
 * see the catalogue, including Instant webinar. */

import assert from "node:assert/strict";
import type { Feature } from "./api-types.ts";
import {
  accountFeatureRows,
  accountFeaturesOnCount,
  overrideState,
  planIncludes,
  withOverride,
} from "./admin-account-features.ts";

const catalogue: Feature[] = [
  {
    key: "whatsapp_crm",
    label: "WhatsApp CRM",
    description: "Contact tools.",
  },
  {
    key: "cloud_recording",
    label: "Cloud recording",
    description: "Record to cloud storage.",
  },
  {
    key: "join_without_registration",
    label: "Join without registration",
    description: "Name only, no form.",
  },
  {
    key: "instant_webinar",
    label: "Instant webinar",
    description: "Go live without scheduling.",
  },
  {
    key: "zoom",
    label: "Zoom",
    description: "Run the session on Zoom.",
  },
];

const hostRows = accountFeatureRows(true, catalogue);
assert.deepEqual(
  hostRows.map((row) => row.label),
  ["WhatsApp CRM", "Cloud recording", "Join without registration", "Instant webinar", "Zoom"],
);
assert.deepEqual(
  hostRows.map((row) => row.id),
  catalogue.map((f) => f.key),
);
assert.ok(hostRows.every((row) => row.source === "feature"));

assert.equal(accountFeaturesOnCount(hostRows, ["whatsapp_crm"]), 1);
assert.equal(accountFeaturesOnCount(hostRows, ["whatsapp_crm", "instant_webinar"]), 2);
assert.equal(accountFeaturesOnCount(hostRows, ["not_a_real_feature"]), 0);

// A non-host sees no switches (CDN Broadcast, the one row they had, was retired).
const guestRows = accountFeatureRows(false, catalogue);
assert.equal(guestRows.length, 0);
assert.equal(accountFeaturesOnCount(guestRows, ["instant_webinar", "zoom"]), 0);

/* Plan, then overrides. Inherit is the absence of an override; the plan's value
 * comes from the tier matrix, "" being no plan. */
assert.equal(overrideState(undefined, "zoom"), "inherit");
assert.equal(overrideState({ zoom: true }, "zoom"), "on");
assert.equal(overrideState({ zoom: false }, "zoom"), "off");
assert.equal(overrideState({ zoom: true }, "whiteboard"), "inherit");

const tiers = [
  { plan: "", features: ["whiteboard"] },
  { plan: "professional", features: ["whiteboard", "zoom"] },
];
assert.equal(planIncludes(null, "", "zoom"), null);
assert.equal(planIncludes(tiers, undefined, "zoom"), false);
assert.equal(planIncludes(tiers, "", "whiteboard"), true);
assert.equal(planIncludes(tiers, "professional", "zoom"), true);
assert.equal(planIncludes(tiers, "enterprise", "zoom"), false);

assert.deepEqual(withOverride({ zoom: true }, "zoom", "inherit"), {});
assert.deepEqual(withOverride(undefined, "zoom", "off"), { zoom: false });
assert.deepEqual(withOverride({ zoom: false }, "whiteboard", "on"), { zoom: false, whiteboard: true });
