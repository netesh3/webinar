/* Tests for the host home's list filters in the URL.
 *
 * Run with `make test-web`.
 */

import {
  filtersActive,
  listUrl,
  listUrlQuery,
  orderedRange,
  parseListUrl,
  sameListState,
  urlDate,
} from "./host-list-url.ts";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${a}\n        want ${e}`);
}

const none = { tab: "", q: "", from: "", to: "" };

console.log("\nurlDate");
eq(urlDate("2026-03-10"), "2026-03-10", "a real date passes");
eq(urlDate(" 2026-03-10 "), "2026-03-10", "trimmed");
eq(urlDate("2026-02-30"), "", "an impossible date is dropped");
eq(urlDate("2026-13-01"), "", "month 13 is dropped");
eq(urlDate("March"), "", "words are dropped");
eq(urlDate("2026-3-1"), "", "unpadded is dropped");
eq(urlDate(null), "", "absent is empty");

console.log("\nparseListUrl");
eq(parseListUrl(new URLSearchParams("")), none, "the bare address");
eq(
  parseListUrl(new URLSearchParams("tab=past&q=pricing+101&from=2026-03-01&to=2026-03-31")),
  { tab: "past", q: "pricing 101", from: "2026-03-01", to: "2026-03-31" },
  "every field",
);
eq(
  parseListUrl(new URLSearchParams("tab=attending&from=nope&to=2026-02-31")),
  { tab: "attending", q: "", from: "", to: "" },
  "bad dates read as unset",
);
eq(parseListUrl(new URLSearchParams("q=50%25+off")).q, "50% off", "percent decodes");

console.log("\nlistUrlQuery / listUrl");
eq(listUrlQuery(none), "", "nothing set writes nothing");
eq(listUrlQuery({ ...none, tab: "upcoming" }), "", "the default tab is not written");
eq(listUrlQuery({ ...none, tab: "drafts" }), "tab=drafts", "another tab is");
eq(listUrlQuery({ ...none, q: "   " }), "", "a blank search is not written");
eq(listUrlQuery({ ...none, q: " a b " }), "q=a+b", "search is trimmed");
eq(
  listUrlQuery({ tab: "attending", q: "x", from: "2026-01-01", to: "2026-01-31" }),
  "tab=attending&q=x&from=2026-01-01&to=2026-01-31",
  "stable order",
);
eq(listUrlQuery({ ...none, from: "garbage" }), "", "a bad date is not written");
eq(listUrl("/host", none), "/host", "bare path for the default");
eq(listUrl("/host/meetings", { ...none, tab: "past", q: "sync" }), "/host/meetings?tab=past&q=sync", "path and query");

console.log("\nround trip");
for (const s of [
  { tab: "past", q: "pricing", from: "2026-03-01", to: "" },
  { tab: "attending", q: "50% & more", from: "", to: "2026-12-31" },
  { tab: "drafts", q: "", from: "", to: "" },
]) {
  eq(parseListUrl(new URLSearchParams(listUrlQuery(s))), s, `round trip ${JSON.stringify(s)}`);
}
eq(
  parseListUrl(new URLSearchParams(listUrlQuery({ ...none, tab: "upcoming" }))),
  none,
  "the default tab round-trips to unset",
);

console.log("\nsameListState / filtersActive / orderedRange");
eq(sameListState({ ...none, q: "abc " }, { ...none, q: "abc" }), true, "trailing space is the same request");
eq(sameListState({ ...none, tab: "upcoming" }, none), true, "explicit default equals bare");
eq(sameListState({ ...none, tab: "past" }, none), false, "a different tab differs");
eq(filtersActive(none), false, "nothing set");
eq(filtersActive({ q: " ", from: "", to: "" }), false, "blank search is not a filter");
eq(filtersActive({ q: "", from: "2026-01-01", to: "" }), true, "one date is");
eq(orderedRange("2026-02-01", "2026-01-01"), { from: "2026-01-01", to: "2026-02-01" }, "reversed range is swapped");
eq(orderedRange("2026-01-01", ""), { from: "2026-01-01", to: "" }, "one end stays put");

console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
