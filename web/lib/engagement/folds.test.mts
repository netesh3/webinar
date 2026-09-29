/* Which Engagement sections can fold, and how the remembered list is read back.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import { FOLDABLE, parseFolded, toggled } from "./folds.ts";

// Overview is the one section that never folds; every other one does.
assert.ok(!FOLDABLE.includes("overview"));
for (const id of ["attendance", "activity", "attendees", "chat", "qa", "polls", "reactions", "survey", "follow-up"] as const) {
  assert.ok(FOLDABLE.includes(id), id);
}

// Stored values: bad JSON, the wrong shape, and ids that no longer fold all read as nothing folded.
assert.deepEqual(parseFolded(null), []);
assert.deepEqual(parseFolded("not json"), []);
assert.deepEqual(parseFolded('{"qa":true}'), []);
assert.deepEqual(parseFolded('["overview","gone"]'), []);
// Page order, not click order, and no duplicates.
assert.deepEqual(parseFolded('["reactions","chat","chat"]'), ["chat", "reactions"]);

// Folding keeps page order; unfolding removes; a no-op returns the same list.
const a = toggled([], "reactions", true);
assert.deepEqual(toggled(a, "chat", true), ["chat", "reactions"]);
assert.deepEqual(toggled(["chat", "reactions"], "chat", false), ["reactions"]);
assert.equal(toggled(a, "reactions", true), a);
assert.equal(toggled(a, "overview", true), a);

console.log("folds: ok");
