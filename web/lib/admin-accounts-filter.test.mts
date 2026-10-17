/* Tests for the Accounts tab's search and Hosts / Attendees chips.
 *
 * Run with `make test-web`.
 */

import {
  countAccountRoles,
  filterAccounts,
  matchAccountRole,
} from "./admin-accounts-filter.ts";

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

const users = [
  { id: "1", name: "Webinar Liv", email: "webinarliv@gmail.com", canHost: true },
  { id: "2", name: "Chandan Yadav", email: "chandanroy565@gmail.com", canHost: true },
  { id: "3", name: "Abhishek", email: "abhimohite2503@gmail.com", canHost: false },
  { id: "4", name: "Satish Kumar", email: "satish@gmail.com", canHost: false },
  { id: "5", name: "", email: "noname@example.com", canHost: false },
];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

console.log("\nmatchAccountRole");
eq(matchAccountRole({ canHost: true }, "hosts"), true, "a host is a host");
eq(matchAccountRole({ canHost: true }, "attendees"), false, "a host is not an attendee");
eq(matchAccountRole({ canHost: false }, "attendees"), true, "a non-host is an attendee");
eq(matchAccountRole({ canHost: false }, "all"), true, "all is everyone");

console.log("\nfilterAccounts");
eq(ids(filterAccounts(users, "", "all")), ["1", "2", "3", "4", "5"], "no filter keeps order");
eq(ids(filterAccounts(users, "", "hosts")), ["1", "2"], "hosts only");
eq(ids(filterAccounts(users, "", "attendees")), ["3", "4", "5"], "attendees only");
eq(ids(filterAccounts(users, "gmail", "hosts")), ["1", "2"], "search and chip combine");
eq(ids(filterAccounts(users, "  SATISH ", "attendees")), ["4"], "search trims and ignores case");
eq(ids(filterAccounts(users, "satish", "hosts")), [], "a search that misses the chip is empty");
eq(ids(filterAccounts(users, "noname", "all")), ["5"], "a nameless account is found by email");

console.log("\ncountAccountRoles");
eq(countAccountRoles(users, ""), { all: 5, hosts: 2, attendees: 3 }, "counts the whole list");
eq(countAccountRoles(users, "gmail"), { all: 4, hosts: 2, attendees: 2 }, "counts follow the search");
eq(countAccountRoles([], ""), { all: 0, hosts: 0, attendees: 0 }, "an empty list is all zeros");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
