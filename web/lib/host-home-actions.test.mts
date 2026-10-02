/* Host Webinars top: one full-width Schedule card, or Schedule beside Instant.
 *
 * Run: node --experimental-strip-types --no-warnings lib/host-home-actions.test.mts
 */

import assert from "node:assert/strict";
import { FeatureInstantWebinar } from "./api-types.ts";
import {
  hostHomeCreateActions,
  hostHomeCreateColumns,
} from "./host-home-actions.ts";

assert.deepEqual(hostHomeCreateActions(undefined), ["schedule"]);
assert.deepEqual(hostHomeCreateActions(null), ["schedule"]);
assert.deepEqual(hostHomeCreateActions([]), ["schedule"]);
assert.equal(hostHomeCreateColumns(hostHomeCreateActions([])), 1);

// Another admin, or any host, without the switch. No second card.
assert.deepEqual(hostHomeCreateActions(["zoom", "cloud_recording"]), ["schedule"]);
assert.equal(
  hostHomeCreateColumns(hostHomeCreateActions(["zoom", "cloud_recording"])),
  1,
);

const on = hostHomeCreateActions(["zoom", FeatureInstantWebinar]);
assert.deepEqual(on, ["schedule", "instant"]);
assert.equal(hostHomeCreateColumns(on), 2);
assert.equal(on[0], "schedule");
assert.equal(on[1], "instant");
