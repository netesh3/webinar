/* lib/plan-gate.ts: the plan a locked control names. Run:
 * node --experimental-strip-types --no-warnings lib/plan-gate.test.mts */

import assert from "node:assert/strict";
import { SPAM_FILTER_FEATURE, lowestPlanFor, lowestPlanForLimit, planBadgeFor, upgradeHref } from "./plan-gate.ts";
import { TIER_FEATURES } from "./plans.ts";

assert.equal(planBadgeFor("cloud_recording"), "Professional and up");
assert.equal(planBadgeFor("whatsapp_crm"), "Professional and up");
assert.equal(planBadgeFor("audience_insights"), "Professional and up");
assert.equal(planBadgeFor("stream_out"), "Professional and up");
assert.equal(planBadgeFor("csv_export"), "Professional and up");
assert.equal(planBadgeFor("google_drive"), "Business and up");
for (const k of ["captions", "simulive", "replay_engage", "zoom", "ai", "ai_knowledge", "simulive_auto", "repurpose", "followup_send"])
  assert.equal(planBadgeFor(k), "Business and up", k);
assert.equal(planBadgeFor(SPAM_FILTER_FEATURE), "Business and up");
// Per-host switches name no plan; nor does one no plan has.
for (const k of ["clips", "instant_webinar", "hls_delivery", "telepathy"]) assert.equal(planBadgeFor(k), null, k);
// Every badge is a plan that really has the switch.
for (const k of TIER_FEATURES.enterprise) assert.ok(TIER_FEATURES[lowestPlanFor(k)!.id].includes(k), k);
// Limits: the first plan whose number reaches the need.
assert.equal(lowestPlanForLimit("stage", 4)?.name, "Professional");
assert.equal(lowestPlanForLimit("meetingCap", 50)?.name, "Business");
assert.equal(lowestPlanForLimit("recordingGb", 11)?.name, "Business");
assert.equal(lowestPlanForLimit("stage", 1000), null);
assert.equal(upgradeHref(), "/pricing#pricing");

console.log("plan-gate: ok");
