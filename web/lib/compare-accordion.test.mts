/* lib/compare-accordion.ts. Run:
 * node --experimental-strip-types --no-warnings lib/compare-accordion.test.mts */

import assert from "node:assert/strict";
import { allOpen, rowCountLabel, sectionAnchor, sectionFromHash, setAll, toggleSection } from "./compare-accordion.ts";
import { COMPARISON } from "./plans.ts";

const ids = COMPARISON.map((g) => g.id);

// Every section has an anchor a hash can name, and only real sections open from one.
for (const id of ids) assert.equal(sectionFromHash(`#${sectionAnchor(id)}`, ids), id);
assert.equal(sectionFromHash("#compare", ids), null);
assert.equal(sectionFromHash("#compare-nope", ids), null);
assert.equal(sectionFromHash("#pricing", ids), null);
assert.equal(sectionFromHash("", ids), null);

// Starts collapsed: nothing open. A header flips only its own section.
let open = new Set<string>();
assert.equal(allOpen(open, ids), false);
open = toggleSection(open, "ai");
assert.deepEqual([...open], ["ai"]);
open = toggleSection(open, "capacity");
open = toggleSection(open, "ai");
assert.deepEqual([...open], ["capacity"]);

// Expand all / Collapse all.
open = setAll(ids, true);
assert.equal(allOpen(open, ids), true);
assert.equal(open.size, ids.length);
open = setAll(ids, false);
assert.equal(open.size, 0);
assert.equal(allOpen(new Set(), []), false);

assert.equal(rowCountLabel(1), "1 feature");
assert.equal(rowCountLabel(4), "4 features");

console.log("compare-accordion: ok");
