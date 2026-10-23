/* The attendee list export's link. Run with `make test-web`. */
import assert from "node:assert/strict";
import { ATTENDEE_CSV_COLUMNS, ATTENDEE_SCOPES, attendeesCsvPath } from "./attendee-export.ts";

assert.equal(attendeesCsvPath("demo", "attended"), "/api/host/webinars/demo/attendees.csv");
assert.equal(attendeesCsvPath("demo", "all"), "/api/host/webinars/demo/attendees.csv?scope=all");
// One path segment whatever the slug.
assert.equal(attendeesCsvPath("a b/c", "attended"), "/api/host/webinars/a%20b%2Fc/attendees.csv");
// Attended only is first, and the default.
assert.deepEqual(ATTENDEE_SCOPES.map((s) => s.id), ["attended", "all"]);
// Pinned against the Go header (attendee_export_test.go).
assert.equal(ATTENDEE_CSV_COLUMNS[0], "name");
assert.equal(ATTENDEE_CSV_COLUMNS.at(-1), "raised_hand");
assert.equal(ATTENDEE_CSV_COLUMNS.length, 14);

console.log("attendee export: ok");
