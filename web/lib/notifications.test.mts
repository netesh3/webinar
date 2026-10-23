/* The bell's optimistic steps: dismiss one, clear all, read one, read all.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import {
  dismissAlert,
  dismissAllAlerts,
  isDismissKey,
  readAlert,
  readAllAlerts,
  swipeDismisses,
  type BellState,
} from "./notifications.ts";

const start: BellState = {
  alerts: [
    { id: "a", unread: true },
    { id: "b", unread: false },
    { id: "c", unread: true },
  ],
  unread: 2,
};

// Dismissing an unread row drops it and the badge.
const noA = dismissAlert(start, "a");
assert.deepEqual(
  noA.alerts.map((a) => a.id),
  ["b", "c"],
);
assert.equal(noA.unread, 1);

// Dismissing a read row leaves the badge.
const noB = dismissAlert(start, "b");
assert.deepEqual(
  noB.alerts.map((a) => a.id),
  ["a", "c"],
);
assert.equal(noB.unread, 2);

// An id not in the list changes nothing (a double click, a stale row).
assert.equal(dismissAlert(noA, "a"), noA);

// The badge never goes below zero, even if the server count lagged.
assert.equal(
  dismissAlert({ alerts: [{ id: "x", unread: true }], unread: 0 }, "x").unread,
  0,
);

// Clear all.
assert.deepEqual(dismissAllAlerts(), { alerts: [], unread: 0 });

// Read one: the row stays, its flag flips, the badge drops once.
const readA = readAlert(start, "a");
assert.equal(readA.alerts.length, 3);
assert.equal(readA.alerts[0].unread, false);
assert.equal(readA.unread, 1);
assert.equal(
  readAlert(readA, "a"),
  readA,
  "reading a read row twice must not count twice",
);

// Read all: every row stays, none unread, badge zero.
const all = readAllAlerts(start);
assert.equal(all.alerts.length, 3);
assert.ok(all.alerts.every((a) => !a.unread));
assert.equal(all.unread, 0);
// The input is not mutated.
assert.equal(start.alerts[0].unread, true);

// Swipe and keyboard.
assert.equal(swipeDismisses(-120), true);
assert.equal(swipeDismisses(120), true);
assert.equal(swipeDismisses(-30), false);
assert.equal(isDismissKey("Delete"), true);
assert.equal(isDismissKey("Backspace"), true);
assert.equal(isDismissKey("Enter"), false);

console.log("notifications: ok");
