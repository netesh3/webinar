/* The host list's date button: "Filter" until a range is on, then the range.
 *
 * Run: node --experimental-strip-types --no-warnings lib/date-range-label.test.mts
 */

import assert from "node:assert/strict";
import { DATE_FILTER_ACTIVE, dateRangeButtonLabel } from "./date-range-label.ts";

const range = (from: string, to: string) => `${from} → ${to}`;

assert.equal(dateRangeButtonLabel("", "", "Filter", range), "Filter");
assert.equal(dateRangeButtonLabel("  ", "  ", "Filter", range), "Filter");
assert.equal(dateRangeButtonLabel("", "", "Any dates", range), "Any dates");

assert.equal(
  dateRangeButtonLabel("2026-10-01", "2026-10-07", "Filter", range),
  "2026-10-01 → 2026-10-07",
);
assert.equal(
  dateRangeButtonLabel("2026-10-01", "2026-10-07", "Filter", () => "   "),
  DATE_FILTER_ACTIVE,
);
assert.equal(
  dateRangeButtonLabel("2026-10-01", "", "Filter", range),
  DATE_FILTER_ACTIVE,
);
assert.equal(
  dateRangeButtonLabel("", "2026-10-07", "Filter", range),
  DATE_FILTER_ACTIVE,
);

console.log("date-range-label: ok");
