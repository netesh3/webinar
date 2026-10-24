/* Tests for the admin Webinars tab's per-row actions and the delete confirm.
 *
 * Run with `make test-web`.
 */

import {
  adminActionCopy,
  adminSessionActions,
  deleteConfirmMatches,
} from "./admin-session-actions.ts";

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

const row = (status: string, kind = "live", venue?: string) => ({
  topic: "Team sync",
  kind,
  status,
  venue,
});

console.log("adminSessionActions");
eq(adminSessionActions(row("live")), ["end", "delete"], "live: end and delete");
eq(adminSessionActions(row("live", "meeting")), ["end", "delete"], "a live meeting ends too");
eq(adminSessionActions(row("live", "live", "zoom_meeting")), ["delete"], "Zoom ends in Zoom");
eq(adminSessionActions(row("scheduled")), ["unpublish", "delete"], "scheduled: back to draft");
eq(adminSessionActions(row("draft")), ["publish", "delete"], "draft: publish");
eq(adminSessionActions(row("ended")), ["delete"], "ended: no reopen");

console.log("\nadminActionCopy");
eq(adminActionCopy("end", row("live", "meeting")).confirm, "End meeting", "names the kind");
eq(adminActionCopy("delete", row("ended", "simulive")).confirm, "Delete simulive", "simulive noun");

console.log("\ndeleteConfirmMatches");
eq(deleteConfirmMatches("", "Team sync"), false, "empty is not a match");
eq(deleteConfirmMatches("DELETE", "Team sync"), true, "DELETE");
eq(deleteConfirmMatches(" delete ", "Team sync"), true, "case and spaces");
eq(deleteConfirmMatches("team sync", "Team sync"), true, "the topic");
eq(deleteConfirmMatches("team", "Team sync"), false, "part of the topic is not enough");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
