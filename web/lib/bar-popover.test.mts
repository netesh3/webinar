/* When the More panel closes for the rest of the control bar.
 *
 * Run with `make test-web`.
 */

import assert from "node:assert/strict";
import {
  closesMoreOn,
  closesMoreOnToolActivate,
  moreTargetOf,
} from "./bar-popover.ts";

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

/** A stand-in element that matches the given attribute selectors. */
const el = (...matches: string[]) => ({
  closest: (selector: string) => (matches.includes(selector) ? {} : null),
});

test("classifies targets", () => {
  assert.equal(moreTargetOf(el(), true), "panel");
  assert.equal(moreTargetOf(el("[data-tool-slot]"), true), "panel");
  assert.equal(moreTargetOf(el("[data-more-button]"), false), "more-button");
  assert.equal(moreTargetOf(el("[data-tool-slot]"), false), "tool-slot");
  assert.equal(moreTargetOf(el("[data-toolbar-notice]"), false), "notice");
  assert.equal(moreTargetOf(el(), false), "elsewhere");
  assert.equal(moreTargetOf(null, false), "elsewhere");
  // The window, or a text node: no closest at all.
  assert.equal(moreTargetOf({}, false), "elsewhere");
});

test("a press elsewhere (Share, Record, Leave, the video) closes More", () => {
  assert.equal(closesMoreOn("pointerdown", "elsewhere"), true);
});

test("a press on a toolbar tool does not — it may be a drag toward More", () => {
  assert.equal(closesMoreOn("pointerdown", "tool-slot"), false);
});

test("presses inside More, on More itself, or on the undo notice keep it open", () => {
  for (const t of ["panel", "more-button", "notice"] as const) {
    assert.equal(closesMoreOn("pointerdown", t), false, t);
    assert.equal(closesMoreOn("click", t, true), false, t);
  }
});

test("Enter / Space on another bar button closes More", () => {
  assert.equal(closesMoreOn("click", "elsewhere", true), true);
});

test("a pointer click is left to its pointerdown (end of a drag onto the bar)", () => {
  assert.equal(closesMoreOn("click", "elsewhere", false), false);
  assert.equal(closesMoreOn("click", "elsewhere"), false);
});

test("a keyboard click on a toolbar tool is left to the tool's activation", () => {
  assert.equal(closesMoreOn("click", "tool-slot", true), false);
});

test("activating a toolbar tool closes an open More", () => {
  assert.equal(
    closesMoreOnToolActivate({ moreOpen: true, editing: false, dragging: false }),
    true,
  );
});

test("…but not while customising the toolbar", () => {
  assert.equal(
    closesMoreOnToolActivate({ moreOpen: true, editing: true, dragging: false }),
    false,
  );
});

test("…nor mid-drag", () => {
  assert.equal(
    closesMoreOnToolActivate({ moreOpen: true, editing: false, dragging: true }),
    false,
  );
});

test("…and there is nothing to close when More is shut", () => {
  assert.equal(
    closesMoreOnToolActivate({ moreOpen: false, editing: false, dragging: false }),
    false,
  );
});

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
