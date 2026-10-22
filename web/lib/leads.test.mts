/* Hot leads and the follow-up writer's pure half: tags, chips, the CSV, groups, empty
 * states and WhatsApp template wording.
 *
 * Run: node --experimental-strip-types --no-warnings lib/leads.test.mts */

import assert from "node:assert/strict";
import type { Lead } from "./api-types.ts";
import {
  csvCell,
  csvFileName,
  followupsEmptyState,
  groupContactIds,
  groupSegment,
  leadChips,
  leadsAINote,
  leadsCsv,
  leadsInGroup,
  tagLabel,
  tagTone,
  waTemplateWording,
} from "./leads.ts";

// Tags
assert.equal(tagLabel("hot"), "Hot");
assert.equal(tagLabel("warm"), "Warm");
assert.equal(tagLabel("cold"), "Cold");
assert.equal(tagLabel("anything"), "Cold");
assert.equal(tagTone("hot"), "live");
assert.equal(tagTone("warm"), "warn");
assert.equal(tagTone("cold"), "neutral");

// Chips: watch first, then what they did; a no-show says so.
assert.deepEqual(
  leadChips({ joined: true, watchMin: 58, watchPct: 97, questions: 2, upvotes: 1, chats: 3, raisedHand: true }),
  ["Watched 58 min (97%)", "2 questions", "1 upvote", "Raised hand", "3 chat messages"],
);
assert.deepEqual(leadChips({ joined: false, watchMin: 0, watchPct: 0 }), ["No-show"]);
assert.deepEqual(leadChips({ joined: true, watchMin: 5, watchPct: 8, onStage: true, pollAnswers: 1, offerClicks: 2 }), [
  "Watched 5 min (8%)",
  "Clicked offer",
  "Came on stage",
  "1 poll answer",
]);

const leads: Lead[] = [
  {
    key: "r1", name: "Asha Rao", email: "asha@x.in", phone: "+919800000001", score: 62, tag: "hot", group: "attended",
    signals: { joined: true, watchMin: 60, watchPct: 100, questions: 2, chats: 1 },
    reason: 'Asked "how much", twice', contactId: "c1",
  },
  {
    key: "r2", name: "=SUM(A1)", email: "b@x.in", score: 26, tag: "cold", group: "attended",
    signals: { joined: true, watchMin: 39, watchPct: 65 }, contactId: "c2",
  },
  { key: "r3", name: "Brief", score: 3, tag: "cold", group: "left_early", signals: { joined: true, watchMin: 5, watchPct: 8 } },
  { key: "r4", name: "Absent", email: "a@x.in", score: 0, tag: "cold", group: "no_show", signals: { joined: false, watchMin: 0, watchPct: 0 } },
];

// CSV: header, rank order, quoting, and no formula injection.
assert.equal(csvCell("plain"), "plain");
assert.equal(csvCell('say "hi", ok'), '"say ""hi"", ok"');
assert.equal(csvCell("=1+1"), "'=1+1");
assert.equal(csvCell("+91 98"), "'+91 98");
assert.equal(csvCell(5), "5");
const csv = leadsCsv(leads).split("\r\n");
assert.equal(csv[0], "Rank,Name,Email,Phone,Score,Tag,Group,Watch min,Watch %,Questions,Upvotes,Chat messages,Poll answers,Raised hand,On stage,Reason");
assert.equal(csv[1], `1,Asha Rao,asha@x.in,'+919800000001,62,Hot,Attended,60,100,2,0,1,0,no,no,"Asked ""how much"", twice"`);
assert.ok(csv[2].startsWith("2,'=SUM(A1),b@x.in,"));
assert.ok(csv[4].startsWith("4,Absent,a@x.in,,0,Cold,Didn't join,0,0,"));
assert.equal(csv.length, 6); // header, four rows, trailing newline
assert.equal(csvFileName("hot-leads", "Money basics: SIPs & more!"), "hot-leads-money-basics-sips-more.csv");
assert.equal(csvFileName("follow-up", "!!!"), "follow-up.csv");

// Groups: hot overlaps attended.
assert.deepEqual(leadsInGroup(leads, "hot").map((l) => l.key), ["r1"]);
assert.deepEqual(leadsInGroup(leads, "attended").map((l) => l.key), ["r1", "r2"]);
assert.deepEqual(leadsInGroup(leads, "left_early").map((l) => l.key), ["r3"]);
assert.deepEqual(leadsInGroup(leads, "no_show").map((l) => l.key), ["r4"]);
assert.deepEqual(groupContactIds(leads, "attended"), ["c1", "c2"]);
assert.deepEqual(groupContactIds(leads, "left_early"), []);
assert.deepEqual(groupSegment("attended", 60), { attendance: "joined", minWatchMin: 30 });
assert.deepEqual(groupSegment("left_early", 45), { attendance: "joined", maxWatchMin: 23 });
assert.deepEqual(groupSegment("no_show", 60), { attendance: "no_show" });
assert.equal(groupSegment("hot", 60), null);
assert.deepEqual(groupSegment("attended", 0), { attendance: "joined", minWatchMin: 1 });

// Empty states
assert.equal(leadsAINote("ready"), null);
assert.equal(leadsAINote("empty"), null);
assert.match(leadsAINote("ai_limit")!, /AI limit reached/);
assert.match(leadsAINote("ai_off")!, /switched off/);
assert.match(leadsAINote("something new")!, /couldn't be written/);
assert.equal(followupsEmptyState("ready"), null);
assert.equal(followupsEmptyState("processing")!.pending, true);
assert.match(followupsEmptyState("ai_limit")!.title, /AI limit reached/);
assert.match(followupsEmptyState("not_ended")!.detail, /once the session ends/);

// WhatsApp template wording: {{first_name}} is the template's {{1}}, the replay is written in.
assert.deepEqual(
  waTemplateWording("Hi {{first_name}}, thanks for joining!\nReplay: {{replay_link}}\n{{offer_link}}", "https://x.in/w/a/recording/1"),
  { body: "Hi {{1}}, thanks for joining!\nReplay: https://x.in/w/a/recording/1", params: [{ field: "first_name" }] },
);
assert.deepEqual(waTemplateWording("We missed you {{ first_name }} . Replay soon", undefined), {
  body: "We missed you {{1}}. Replay soon",
  params: [{ field: "first_name" }],
});
assert.deepEqual(waTemplateWording("No name here", ""), { body: "No name here", params: [] });

console.log("leads: ok");
