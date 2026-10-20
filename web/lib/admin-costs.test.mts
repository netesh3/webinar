/* What the admin screen says a stage costs.
 *
 * Run: node --experimental-strip-types --no-warnings lib/admin-costs.test.mts
 *
 * Every stage member receives every other one, so traffic is n·(n−1) streams, and the
 * estimate has to grow with the square: a 10-person stage is 15× a 3-person one, not 3×. */

import assert from "node:assert/strict";
import { FEATURE_COSTS, stageCostText, stageMbps } from "./admin-costs.ts";
import { FeatureEdgeDelivery } from "./api-types.ts";

assert.deepEqual(stageMbps(1), [0, 0]);
assert.deepEqual(stageMbps(3), [6 * 0.6, 6 * 2]);
const [lo3] = stageMbps(3);
const [lo10] = stageMbps(10);
assert.equal(Math.round(lo10 / lo3), 15);

assert.match(stageCostText(10), /^10 on stage: ~54–180 Mbps/);
assert.match(stageCostText(10), /\$2\.9–\$9\.7 per live hour/);
assert.match(stageCostText(1), /no stage-to-stage traffic/);
assert.ok(FEATURE_COSTS[FeatureEdgeDelivery].includes("per attendee-hour"));

console.log("admin-costs: ok");
