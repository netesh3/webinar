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
  bulkGrants,
  groupFeatureRows,
  overrideState,
  planIncludes,
  unmetRequirements,
  withOverride,
  withOverrides,
} from "./admin-account-features.ts";

const catalogue: Feature[] = [
  {
    key: "whatsapp_crm",
    label: "WhatsApp CRM",
    description: "Contact tools.",
    group: "integrations",
  },
  {
    key: "cloud_recording",
    label: "Cloud recording",
    description: "Record to cloud storage.",
    group: "delivery",
  },
  {
    key: "join_without_registration",
    label: "Join without registration",
    description: "Name only, no form.",
    group: "sessions",
  },
  {
    key: "instant_webinar",
    label: "Instant webinar",
    description: "Go live without scheduling.",
    group: "sessions",
  },
  {
    key: "zoom",
    label: "Zoom",
    description: "Run the session on Zoom.",
    group: "integrations",
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

/* Groups, dependencies and the bulk toggle. */
const aiCatalogue: Feature[] = [
  ...catalogue,
  { key: "ai", label: "AI writing", description: "AI.", group: "ai" },
  { key: "ai_knowledge", label: "AI knowledge", description: "Library.", group: "ai", requires: ["ai"] },
  { key: "mystery", label: "Mystery", description: "No group the server listed.", group: "nowhere" },
];
const groups = [
  { key: "sessions", label: "Sessions" },
  { key: "ai", label: "AI" },
  { key: "delivery", label: "Delivery & recording" },
  { key: "integrations", label: "Integrations" },
];
const aiRows = accountFeatureRows(true, aiCatalogue);
const grouped = groupFeatureRows(aiRows, groups);
assert.deepEqual(
  grouped.map((g) => [g.label, g.rows.map((r) => r.id)]),
  [
    ["Sessions", ["join_without_registration", "instant_webinar"]],
    ["AI", ["ai", "ai_knowledge"]],
    ["Delivery & recording", ["cloud_recording"]],
    ["Integrations", ["whatsapp_crm", "zoom"]],
    ["Other", ["mystery"]],
  ],
);
const knowledgeRow = aiRows.find((r) => r.id === "ai_knowledge")!;
assert.deepEqual(unmetRequirements(knowledgeRow, ["whiteboard"], aiCatalogue), ["AI writing"]);
assert.deepEqual(unmetRequirements(knowledgeRow, ["ai"], aiCatalogue), []);
assert.deepEqual(unmetRequirements(aiRows[0], [], aiCatalogue), []);

const aiGroup = grouped[1].rows;
assert.deepEqual(bulkGrants(aiGroup, "on"), [
  { feature: "ai", enabled: true },
  { feature: "ai_knowledge", enabled: true },
]);
assert.deepEqual(bulkGrants(aiGroup, "inherit"), [
  { feature: "ai", enabled: false, inherit: true },
  { feature: "ai_knowledge", enabled: false, inherit: true },
]);
assert.deepEqual(withOverrides({ zoom: true, ai: true }, ["ai", "ai_knowledge"], "off"), {
  zoom: true,
  ai: false,
  ai_knowledge: false,
});
assert.deepEqual(withOverrides({ ai: true }, ["ai"], "inherit"), {});
