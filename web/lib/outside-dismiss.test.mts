/* iOS leftover pointerdown must not close a popover the instant it opens.
 *
 * Run with `make test-web`.
 */

import assert from "node:assert/strict";
import { OUTSIDE_DISMISS_FLOOR_MS, outsideDismissReady } from "./outside-dismiss.ts";

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(err);
  }
}

test("not ready while the opening finger is still down", () => {
  assert.equal(outsideDismissReady(0, 1_000, { pointerDown: true }), false);
});

test("not ready before the floor, even after release", () => {
  assert.equal(
    outsideDismissReady(0, OUTSIDE_DISMISS_FLOOR_MS - 1, { pointerDown: false }),
    false,
  );
});

test("ready after the floor once the pointer is up", () => {
  assert.equal(
    outsideDismissReady(0, OUTSIDE_DISMISS_FLOOR_MS, { pointerDown: false }),
    true,
  );
});

if (failed) process.exit(1);
console.log("outside-dismiss: ok");
