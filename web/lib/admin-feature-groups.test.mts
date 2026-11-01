/* lib/admin-feature-groups.ts. Run:
 * node --experimental-strip-types --no-warnings lib/admin-feature-groups.test.mts */

import assert from "node:assert/strict";
import * as T from "./api-types.ts";
import {
  ADMIN_FEATURE_GROUPS,
  adminSwitchGroups,
  groupedKeys,
  limitText,
  planGives,
  switchState,
  switchStateText,
} from "./admin-feature-groups.ts";
import { COMPARISON } from "./plans.ts";

// Every switch the server has (the Feature* constants tygo writes from types.Features) is in
// exactly one admin group.
const serverKeys = Object.entries(T)
  .filter(([name, v]) => /^Feature[A-Z]/.test(name) && !name.startsWith("FeatureGroup") && typeof v === "string")
  .map(([, v]) => v as string);
assert.ok(serverKeys.length >= 21, `only ${serverKeys.length} feature keys found`);
const keys = groupedKeys();
for (const k of serverKeys) assert.equal(keys.filter((x) => x === k).length, 1, `${k} must be in exactly one group`);
for (const k of keys) assert.ok(serverKeys.includes(k), `${k} is not a server feature`);

// The groups are the comparison's sections, in its order, then Admin only.
const sectionIds = COMPARISON.map((g) => g.id);
const groupIds = ADMIN_FEATURE_GROUPS.map((g) => g.id).filter((id) => id !== "admin");
assert.deepEqual(groupIds, sectionIds.filter((id) => groupIds.includes(id)));
for (const g of ADMIN_FEATURE_GROUPS.filter((g) => g.id !== "admin"))
  assert.equal(g.title, COMPARISON.find((c) => c.id === g.id)!.title);
assert.deepEqual(
  ADMIN_FEATURE_GROUPS.at(-1)!.features.map((f) => f.key).sort(),
  ["clips", "hls_delivery", "instant_webinar"],
);

// Customer-facing names.
const label = (k: string) => ADMIN_FEATURE_GROUPS.flatMap((g) => g.features).find((f) => f.key === k)!.label;
assert.equal(label("captions"), "AI Live captions");
assert.equal(label("repurpose"), "AI Blog, newsletter and social drafts");
assert.equal(label("google_drive"), "Google Drive");
assert.equal(label("csv_export"), "CSV exports");
assert.equal(label("audience_insights"), "Audience device & location insights");
assert.ok(label("stream_out").startsWith("Stream to YouTube, LinkedIn"));

// From the catalogue: unknown keys go to Other, search filters by label, key or description.
const catalogue = [
  { key: "captions", label: "x", description: "Live captions from the server", group: "delivery" },
  { key: "clips", label: "x", description: "Clips", group: "delivery", perHost: true },
  { key: "telepathy", label: "Telepathy", description: "New", group: "sessions" },
] as T.Feature[];
const groups = adminSwitchGroups(catalogue);
assert.deepEqual(groups.map((g) => g.id), ["ai", "admin", "other"]);
assert.equal(groups[0].switches[0].label, "AI Live captions");
assert.equal(groups[1].switches[0].perHost, true);
assert.deepEqual(adminSwitchGroups(catalogue, "telep").map((g) => g.id), ["other"]);
assert.deepEqual(adminSwitchGroups(catalogue, "server").map((g) => g.id), ["ai"]);

// Three states, and the words for them.
const user = { featureOverrides: { ai: true, zoom: false } };
assert.equal(switchState(user, "ai"), "on");
assert.equal(switchState(user, "zoom"), "off");
assert.equal(switchState(user, "captions"), "plan");
const tiers = [{ plan: "business", features: ["captions"] }] as T.PlanFeatures[];
assert.equal(planGives(tiers, "business", "captions"), true);
assert.equal(planGives(tiers, "basic", "captions"), false);
assert.equal(planGives(null, "basic", "captions"), null);
assert.equal(switchStateText("plan", "business", true, false), "From plan (Business): on");
assert.equal(switchStateText("plan", undefined, false, false), "From plan (No plan): off");
assert.equal(switchStateText("on", "basic", false, false), "On for this host");
assert.equal(switchStateText("off", "business", true, false), "Off for this host");
assert.equal(switchStateText("plan", "business", false, true), "Off: admin only");

assert.equal(limitText(5, null, "on stage"), "5 on stage (plan)");
assert.equal(limitText(5, 8, "on stage"), "8 on stage (override; plan 5)");

console.log("admin-feature-groups: ok");
