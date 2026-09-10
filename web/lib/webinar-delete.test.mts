/* The warning shown before an irreversible delete.
 *
 * Copy does not usually deserve a test. This does, because the delete is irreversible and the
 * dialog is the only thing standing between a host and losing an attendance record — and
 * because the previous version was WRONG in a way nobody would notice: it said "and its
 * registration page are removed" for every status, having been written when only drafts could
 * be deleted. A host deleting a finished webinar was told they were tidying up a page.
 *
 * So each status is asserted to mention the things a host would be angry to lose silently.
 *
 * Run: node --experimental-strip-types --no-warnings lib/webinar-delete.test.mts
 */
import type { Webinar } from "./api-types.ts";
import { deleteTitle, deleteWarning } from "./webinar-delete.ts";

let passed = 0;
let failed = 0;

function mentions(label: string, text: string, ...needles: string[]) {
  const missing = needles.filter((n) => !text.toLowerCase().includes(n.toLowerCase()));
  if (missing.length === 0) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}\n        missing ${JSON.stringify(missing)}\n        in "${text}"`);
  }
}
function absent(label: string, text: string, needle: string) {
  if (!text.toLowerCase().includes(needle.toLowerCase())) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}\n        "${needle}" should not appear in "${text}"`);
  }
}

/** Only the fields this module reads. Cast because a full Webinar is forty fields of
 *  irrelevance here, and a fixture that has to be maintained is a fixture that goes stale. */
function webinar(status: Webinar["status"], registrantCount = 0): Webinar {
  return { topic: "Quarterly Update", status, registrantCount } as Webinar;
}

console.log("every status says what it costs");
for (const status of ["draft", "scheduled", "live", "ended"] as const) {
  const body = deleteWarning(webinar(status, 48));
  mentions(`${status} names the webinar`, body, "Quarterly Update");
  mentions(`${status} says it is final`, body, "cannot be undone");
}

console.log("a draft is the only one with nothing to lose");
{
  const draft = deleteWarning(webinar("draft", 0));
  // A draft has no public page and no audience. Warning about registrations it cannot have
  // would be noise, and noise in a confirmation is what teaches people to click through.
  absent("a draft does not claim registrations are deleted", draft, "registrations");
  absent("nor a chat transcript", draft, "transcript");
}

console.log("a live webinar warns about the people in the room");
{
  const live = deleteWarning(webinar("live", 48));
  mentions("live says everyone is disconnected", live, "running now", "disconnected");
  mentions("live still lists the data", live, "chat transcript", "recording");
  mentions("live counts the registrants", live, "48 registrants");
  mentions("and the title says it is live", deleteTitle(webinar("live")), "while it is live");
}

console.log("an ended webinar warns that this is the only copy");
{
  const ended = deleteWarning(webinar("ended", 210));
  mentions(
    "ended names the record being destroyed",
    ended,
    "already run",
    "only record",
    "attendance report",
  );
  mentions("ended lists the data too", ended, "polls", "recording");
  mentions("and the title says records", deleteTitle(webinar("ended")), "records");
}

console.log("the registrant count reads correctly, or not at all");
{
  mentions("one registrant is singular", deleteWarning(webinar("scheduled", 1)), "1 registrant lose");
  mentions("two are plural", deleteWarning(webinar("scheduled", 2)), "2 registrants lose");
  absent(
    "nobody registered means no count at all",
    deleteWarning(webinar("scheduled", 0)),
    "registrants lose",
  );
  /* Thousands are grouped. "1200 registrants" is a number somebody has to count digits in at
   * the moment they are deciding whether to destroy it. */
  mentions("large counts are grouped", deleteWarning(webinar("scheduled", 1200)), "1,200");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"}  ${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
