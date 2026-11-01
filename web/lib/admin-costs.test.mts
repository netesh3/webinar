/* Stage traffic (lib/admin-costs.ts).
 *
 * Run: node --experimental-strip-types --no-warnings lib/admin-costs.test.mts
 *
 * Every stage member receives every other one, so traffic is n·(n−1) streams, and the
 * estimate has to grow with the square: a 10-person stage is 15× a 3-person one, not 3×. */

import assert from "node:assert/strict";
import { stageMbps } from "./admin-costs.ts";

assert.deepEqual(stageMbps(1), [0, 0]);
assert.deepEqual(stageMbps(3), [6 * 0.6, 6 * 2]);
const [lo3] = stageMbps(3);
const [lo10] = stageMbps(10);
assert.equal(Math.round(lo10 / lo3), 15);

console.log("admin-costs: ok");
