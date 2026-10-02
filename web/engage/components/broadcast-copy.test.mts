/* How a broadcast is named on the tab.
 *
 * Run with node --experimental-strip-types. Language codes stay Meta's on the
 * wire and are written out in the list. A contacts or segment audience is not
 * "everyone who opted in".
 */

import {
  audienceDraft,
  audienceLabel,
  broadcastMenuActions,
  broadcastTitle,
  deleteBroadcastCopy,
  deliveryPercent,
  languageLabel,
  peopleFilterForLabel,
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

eq(peopleFilterForLabel("Didn't come"), "never_attended", "people label maps back");
eq(peopleFilterForLabel("No-shows"), "", "a custom name is not a people row");
eq(
  audienceDraft({ audience: "opted_in", name: "Everyone" }),
  { kind: "opted_in", peopleFilter: "", webinarId: "", tagId: "" },
  "opted-in draft",
);
eq(
  audienceDraft({ audience: "contacts", name: "Came", webinarId: "slug" }),
  { kind: "people", peopleFilter: "attended", webinarId: "slug", tagId: "" },
  "a people-page name reopens that row",
);
eq(
  audienceDraft({ audience: "segment", name: "No-shows", webinarId: "slug" }),
  { kind: "locked", peopleFilter: "", webinarId: "slug", tagId: "" },
  "a segment stays the same group",
);
eq(
  broadcastMenuActions("scheduled").map((a) => a.id),
  ["edit", "duplicate", "delete"],
  "scheduled can be edited",
);
eq(
  broadcastMenuActions("draft").map((a) => a.id),
  ["edit", "duplicate", "delete"],
  "a draft can be edited",
);
eq(
  broadcastMenuActions("sending").map((a) => a.id),
  ["delete"],
  "sending can only be stopped by deleting",
);
eq(
  broadcastMenuActions("sent").map((a) => a.id),
  ["duplicate", "delete"],
  "sent is copied or removed, not edited",
);
eq(
  broadcastMenuActions("cancelled").map((a) => a.id),
  ["duplicate", "delete"],
  "cancelled is copied or removed",
);
eq(
  broadcastMenuActions("failed").map((a) => a.id),
  ["duplicate", "delete"],
  "failed is copied or removed",
);
eq(deleteBroadcastCopy("scheduled").confirm, "Delete broadcast", "delete confirm");
eq(
  deleteBroadcastCopy("sent").body.includes("Chats"),
  true,
  "deleting a sent broadcast says the chat stays",
);

if (failures) {
  console.log(`\n${failures} of ${checks} failed`);
  process.exit(1);
}
console.log(`${checks} checks passed`);
