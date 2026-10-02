/* How a broadcast is named on the tab.
 *
 * Run with node --experimental-strip-types. Language codes stay Meta's on the
 * wire and are written out in the list. A contacts or segment audience is not
 * "everyone who opted in".
 */

import {
  audienceLabel,
  broadcastTitle,
  deliveryPercent,
  languageLabel,
  readPercent,
} from "./broadcast-copy.ts";

let failures = 0;
let checks = 0;

function eq(actual: unknown, expected: unknown, what: string): void {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${a}\n        want ${e}`);
}

eq(languageLabel("en_US"), "English (US)", "US English");
eq(languageLabel("en"), "English", "English without a region");
eq(languageLabel("pt_BR"), "Portuguese (BR)", "Brazilian Portuguese");
eq(languageLabel(""), "", "blank language");

eq(deliveryPercent(1, 1), 100, "fully delivered");
eq(deliveryPercent(0, 24), 0, "nothing delivered yet");
eq(deliveryPercent(1, 0), 0, "no recipients");
eq(readPercent(1, 1), "100%", "all read");
eq(readPercent(0, 0), null, "read percent waits until something is sent");

eq(
  audienceLabel({ audience: "opted_in", name: "No-shows" }),
  "Everyone who opted in",
  "opted-in chip",
);
eq(
  broadcastTitle({ audience: "opted_in", name: "No-shows" }),
  "No-shows",
  "card title is the host's name",
);
eq(
  audienceLabel({ audience: "contacts", name: "Came", segmentLabel: "12 picked" }),
  "12 picked",
  "a hand-picked group is not everyone who opted in",
);
eq(
  audienceLabel({
    audience: "webinar",
    webinarTopic: "Morning routines",
  }),
  "Registrants for Morning routines",
  "webinar audience",
);
eq(
  audienceLabel({ audience: "tag", tagName: "VIP" }),
  "Everybody tagged VIP",
  "tag audience",
);

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
