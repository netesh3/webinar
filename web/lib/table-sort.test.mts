/* Column sorting: case, numbers, dates, empty values, and the click cycle.
 * Run with `make test-web`. */

import assert from "node:assert/strict";
import { compareSortValues, cycleColumnSort, sortBy } from "./table-sort.ts";

assert.deepEqual(
  sortBy([{ n: "b" }, { n: "A" }, { n: "a" }], "asc", (r) => r.n, "string").map((r) => r.n),
  ["A", "a", "b"],
);

assert.deepEqual(
  sortBy([{ n: 10 }, { n: 2 }, { n: 2 }], "asc", (r) => r.n, "number").map((r) => r.n),
  [2, 2, 10],
);

assert.deepEqual(
  sortBy(
    [{ t: "2020-01-02T00:00:00Z" }, { t: "2019-12-31T00:00:00Z" }],
    "asc",
    (r) => r.t,
    "date",
  ).map((r) => r.t),
  ["2019-12-31T00:00:00Z", "2020-01-02T00:00:00Z"],
);

// Empty stays last whether the column is ascending or descending.
for (const dir of ["asc", "desc"] as const) {
  const nums = sortBy([{ n: 1 }, { n: null }, { n: 3 }], dir, (r) => r.n, "number").map((r) => r.n);
  assert.equal(nums[2], null, dir);
  const text = sortBy([{ n: "b" }, { n: "" }, { n: "a" }], dir, (r) => r.n, "string").map((r) => r.n);
  assert.equal(text[2], "", dir);
}

// Ties keep the input order.
assert.deepEqual(
  sortBy(
    [
      { name: "Ada", id: 1 },
      { name: "ada", id: 2 },
    ],
    "asc",
    (r) => r.name,
    "string",
  ).map((r) => r.id),
  [1, 2],
);

// A numeric column does not use text order: 10 follows 2. The same digits as text do not.
assert.ok(compareSortValues(10, 2, "number", "asc") > 0);
assert.ok(compareSortValues("10", "2", "string", "asc") < 0);

let sort: { key: "name" | null; dir: "asc" | "desc" } = { key: null, dir: "asc" };
sort = cycleColumnSort(sort, "name", { defaultDir: "asc" });
assert.deepEqual(sort, { key: "name", dir: "asc" });
sort = cycleColumnSort(sort, "name", { defaultDir: "asc" });
assert.deepEqual(sort, { key: "name", dir: "desc" });
sort = cycleColumnSort(sort, "name", { defaultDir: "asc" });
assert.deepEqual(sort, { key: null, dir: "asc" });

// A table that always has a sort toggles, and a new column starts at its own default.
sort = { key: "name", dir: "asc" };
sort = cycleColumnSort(sort, "name", { defaultDir: "asc", reset: false });
assert.deepEqual(sort, { key: "name", dir: "desc" });
sort = cycleColumnSort(sort, "name", { defaultDir: "asc", reset: false });
assert.deepEqual(sort, { key: "name", dir: "asc" });
assert.deepEqual(
  cycleColumnSort<"name" | "score">({ key: "score", dir: "asc" }, "name", { defaultDir: "desc" }),
  { key: "name", dir: "desc" },
);
