/* Host Webinars top: Schedule in the left column, Instant beside it when on.
 *
 * Flag off still uses two columns, so Schedule stays the same width. Below
 * sm the page stacks, and Schedule is full width either way.
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
assert.equal(hostHomeCreateColumns(hostHomeCreateActions([])), 2);

// Another admin, or any host, without the switch. No second card, and
// Schedule stays in the left column rather than spanning the row.
assert.deepEqual(hostHomeCreateActions(["zoom", "cloud_recording"]), ["schedule"]);
assert.equal(
  hostHomeCreateColumns(hostHomeCreateActions(["zoom", "cloud_recording"])),
  2,
);

const on = hostHomeCreateActions(["zoom", FeatureInstantWebinar]);
assert.deepEqual(on, ["schedule", "instant"]);
assert.equal(hostHomeCreateColumns(on), 2);
assert.equal(on[0], "schedule");
assert.equal(on[1], "instant");
