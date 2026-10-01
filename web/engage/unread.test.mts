/* Opening a chat or a notification drops it from the unread number once, and
 * not below zero. Run with `make test-web`. */

import assert from "node:assert/strict";
import { applyAlertRead, applyThreadRead, type UnreadSnap } from "./unread.ts";

function snap(over: Partial<UnreadSnap> = {}): UnreadSnap {
  return {
    unread: 2,
    recent: [
      { contactId: "a", webinarId: "w1" },
      { contactId: "b", webinarId: "w1" },
    ],
    byWebinar: { w1: 2 },
    ...over,
  };
}

const seen = new Set<string>();
const once = applyThreadRead(snap(), "a", seen);
assert.equal(once.unread, 1);
assert.deepEqual(once.recent.map((r) => r.contactId), ["b"]);
assert.deepEqual(once.byWebinar, { w1: 1 });

const twice = applyThreadRead(once, "a", seen);
assert.equal(twice, once, "a second open of the same thread must not count twice");

const offList = applyThreadRead(
  snap({ unread: 9, recent: [], byWebinar: {} }),
  "not-in-the-preview",
  new Set(),
);
assert.equal(offList.unread, 8, "a thread past the preview still leaves the badge");

const floor = applyThreadRead(snap({ unread: 0, recent: [], byWebinar: {} }), "a", new Set());
assert.equal(floor.unread, 0);

const last = applyThreadRead(snap({ unread: 1, recent: [{ contactId: "a", webinarId: "w1" }], byWebinar: { w1: 1 } }), "a", new Set());
assert.deepEqual(last.byWebinar, {});

assert.equal(applyAlertRead(3, true), 2);
assert.equal(applyAlertRead(3, false), 3);
assert.equal(applyAlertRead(0, true), 0);

console.log("ok   unread badges");
