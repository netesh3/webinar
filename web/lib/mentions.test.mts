/* Tests for @mentions: the picker's matching and permission rules, how a tag survives
 * edits in a plain textarea, and how a delivered message is split for highlighting.
 *
 * Run with `make test-web`.
 *
 * The permission cases mirror TestFilterMentionsMatrix in api/internal/api — the
 * server is the authority, and this copy exists so the picker never offers somebody
 * the server would drop, or somebody the host has hidden.
 */

import {
  activeQuery,
  badgeText,
  canMention,
  coalesceMentions,
  mentionHeadline,
  unseenMentions,
  deleteMention,
  draftSegments,
  filterCandidates,
  fold,
  insertMention,
  matchesName,
  MAX_MENTIONS,
  MENTION_EVERYONE,
  mentionCandidates,
  mentionSegments,
  mentionsMe,
  outgoingMentions,
  reconcileMentions,
  type Draft,
  type MentionCandidate,
  type MentionContext,
} from "./mentions.ts";

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

const HOST: MentionCandidate = { identity: "user_host", name: "Pat Host", role: "host" };
const ALEX: MentionCandidate = { identity: "user_alex", name: "Alex Chen", role: "panelist" };
const ALEX2: MentionCandidate = { identity: "att_alex", name: "Alex Chen", role: "attendee" };
const JOSE: MentionCandidate = { identity: "att_jose", name: "José Álvarez", role: "attendee" };
const SAM: MentionCandidate = { identity: "att_sam", name: "Sam Alvarez", role: "attendee" };
const ME: MentionCandidate = { identity: "att_me", name: "Me Myself", role: "attendee" };
const PEOPLE = [HOST, ALEX, ALEX2, JOSE, SAM, ME];

console.log("\nmatching");
{
  eq(fold("José Álvarez"), "jose alvarez", "fold drops diacritics and case");
  eq(matchesName("Alex Chen", "al"), true, "prefix of the first word");
  eq(matchesName("Alex Chen", "CH"), true, "prefix of a later word, any case");
  eq(matchesName("José Álvarez", "alv"), true, "diacritic-insensitive");
  eq(matchesName("Alex Chen", "le"), false, "not a substring match");
  eq(matchesName("Alex Chen", "alex c"), true, "several words narrow");
  eq(matchesName("Alex Chen", "alex d"), false, "…and every word must match");
  eq(
    filterCandidates(PEOPLE, "al").map((c) => c.identity),
    ["user_alex", "att_alex", "att_jose", "att_sam"],
    "first-word matches first, then the stage before the audience, then by name",
  );
  eq(filterCandidates(PEOPLE, "").length, PEOPLE.length, "an empty query lists everyone");
}

console.log("\npermission");
const ctx = (over: Partial<MentionContext> = {}): MentionContext => ({
  me: { identity: "att_me", role: "attendee" },
  canMentionEveryone: false,
  hideAttendees: false,
  destination: "everyone",
  ...over,
});
{
  const ids = (c: MentionContext) => mentionCandidates(c, PEOPLE).map((p) => p.identity);
  eq(ids(ctx()), ["user_host", "user_alex", "att_alex", "att_jose", "att_sam"],
    "attendee, visible audience: everyone but themselves");
  eq(ids(ctx({ hideAttendees: true })), ["user_host", "user_alex"],
    "attendee, hidden audience: the stage only — hidden people are never offered");
  eq(ids(ctx({ destination: "panelists" })), ["user_host", "user_alex"],
    "a panelists-only message offers only people who can read it");
  const host = ctx({ me: { identity: "user_host", role: "host" }, canMentionEveryone: true, hideAttendees: true });
  eq(ids(host), [MENTION_EVERYONE, "user_alex", "att_alex", "att_jose", "att_sam", "att_me"],
    "the host sees @everyone and the whole room, hidden or not");
  eq(ids({ ...host, destination: "panelists" }), [MENTION_EVERYONE, "user_alex"],
    "…but a stage-only message still offers only the stage");
  eq(canMention(ctx(), { ...HOST, identity: MENTION_EVERYONE }), false,
    "an attendee cannot use @everyone");
  eq(
    mentionCandidates(ctx(), [{ identity: "EG_rec", name: "Recorder", role: "host" }, HOST])
      .map((p) => p.identity),
    ["user_host"],
    "recorder and egress participants are never offered",
  );
  eq(
    mentionCandidates(ctx(), [HOST, { ...HOST, name: "Stale" }]).map((p) => p.name),
    ["Pat Host"],
    "the first source for an identity wins",
  );
}

console.log("\nthe draft");
{
  const empty: Draft = { text: "", mentions: [] };
  eq(activeQuery({ text: "@al", mentions: [] }, 3), { start: 0, query: "al" }, "@ at the start");
  eq(activeQuery({ text: "hi @al", mentions: [] }, 6), { start: 3, query: "al" }, "@ after a space");
  eq(activeQuery({ text: "ana@ex", mentions: [] }, 6), null, "an email address is not a tag");
  eq(activeQuery({ text: "@alex c", mentions: [] }, 7), { start: 0, query: "alex c" }, "a space narrows");
  eq(activeQuery({ text: "@a\nb", mentions: [] }, 4), null, "a newline ends the query");
  eq(activeQuery(empty, 0), null, "nothing typed, nothing open");

  const picked = insertMention({ text: "hey @al", mentions: [] }, 4, 7, ALEX);
  eq(picked.text, "hey @Alex Chen ", "picking inserts @Name and a space");
  eq(picked.mentions, [{ identity: "user_alex", name: "Alex Chen", start: 4, end: 14 }], "…and tracks it");
  eq(picked.caret, 15, "…with the caret after the space");
  eq(activeQuery(picked, 10), null, "the caret inside a placed tag does not reopen the picker");

  // Two people with the same name stay two different tags.
  const both = insertMention(
    { text: picked.text + "and @al", mentions: picked.mentions },
    19, 22, ALEX2,
  );
  eq(outgoingMentions(both), ["user_alex", "att_alex"], "duplicate names keep distinct identities");

  // Typing before a tag shifts it; typing inside one drops it.
  const shifted = reconcileMentions(picked, "oh hey @Alex Chen ");
  eq(shifted, [{ identity: "user_alex", name: "Alex Chen", start: 7, end: 17 }], "an edit before a tag shifts it");
  eq(reconcileMentions(picked, "hey @Alex Chan "), [], "an edit inside a tag drops it");
  eq(reconcileMentions(picked, "hey @Alex Chen, hi"), picked.mentions, "an edit after a tag leaves it alone");
  eq(reconcileMentions(picked, ""), [], "clearing the box clears the tags");

  const back = deleteMention(picked, 14, 14, "Backspace");
  eq(back?.text, "hey  ", "Backspace at a tag's end removes the whole tag");
  eq(back?.mentions, [], "…and its entry");
  eq(back?.caret, 4, "…leaving the caret where it started");
  eq(deleteMention(picked, 4, 4, "Delete")?.text, "hey  ", "Delete before a tag removes it too");
  eq(deleteMention(picked, 2, 2, "Backspace"), null, "elsewhere, Backspace is Backspace");
  eq(deleteMention(picked, 4, 10, "Backspace"), null, "a selection deletes as usual");

  eq(
    draftSegments(picked).map((s) => [s.text, s.mention ?? null]),
    [["hey ", null], ["@Alex Chen", "user_alex"], [" ", null]],
    "the composer backdrop highlights exactly the tag",
  );

  let many: Draft = { text: "", mentions: [] };
  for (let i = 0; i < MAX_MENTIONS + 3; i++) {
    const p = { identity: `att_${i}`, name: `P${i}`, role: "attendee" as const };
    many = insertMention({ ...many, text: many.text + "@" }, many.text.length, many.text.length + 1, p);
  }
  eq(outgoingMentions(many).length, MAX_MENTIONS, "outgoing mentions are capped");
}

console.log("\nrendering");
{
  const names: Record<string, string> = { user_alex: "Alex Chen", att_me: "Me Myself", att_jose: "José Álvarez" };
  const nameFor = (id: string) => names[id];
  eq(
    mentionSegments("thanks @Alex Chen!", ["user_alex"], nameFor),
    [{ text: "thanks " }, { text: "@Alex Chen", mention: "user_alex" }, { text: "!" }],
    "a known mention is split out",
  );
  eq(mentionSegments("hello @Alex Chen", undefined, nameFor), [{ text: "hello @Alex Chen" }],
    "no mentions, no highlight — an old message renders as it always did");
  eq(mentionSegments("hi @Alex", ["user_alex"], nameFor), [{ text: "hi @Alex" }],
    "a partial name is not highlighted");
  eq(mentionSegments("@Alex Chenny", ["user_alex"], nameFor), [{ text: "@Alex Chenny" }],
    "a name must end at a word boundary");
  eq(
    mentionSegments("@jose álvarez ok", ["att_jose"], nameFor).map((s) => s.mention ?? null),
    ["att_jose", null],
    "matching is case- and diacritic-insensitive",
  );
  eq(mentionSegments("ping @Ghost", ["att_ghost"], nameFor), [{ text: "ping @Ghost" }],
    "an identity this client cannot name stays plain text");
  eq(
    mentionSegments("@everyone starting now", [MENTION_EVERYONE], nameFor)[0],
    { text: "@everyone", mention: MENTION_EVERYONE },
    "@everyone is highlighted",
  );

  const from = { identity: "user_host" };
  eq(mentionsMe({ mentions: ["att_me"], from }, "att_me"), true, "tagged by identity");
  eq(mentionsMe({ mentions: [MENTION_EVERYONE], from }, "att_me"), true, "tagged by @everyone");
  eq(mentionsMe({ mentions: [MENTION_EVERYONE], from }, "user_host"), false, "…but not by your own");
  eq(mentionsMe({ mentions: ["att_other"], from }, "att_me"), false, "somebody else's tag");
  eq(mentionsMe({ from }, "att_me"), false, "no mentions at all");
}

console.log("\nnotification");
{
  const host = { identity: "user_host", name: "Alex Chen", role: "host" as const };
  const att = { identity: "att_bo", name: "Bo", role: "attendee" as const };
  const msgs = [
    { id: "m1", text: "plain", from: att },
    { id: "m2", text: "@Me Myself  can you\nsee this?", mentions: ["att_me"], from: host },
    { id: "m3", text: "@everyone we start", mentions: [MENTION_EVERYONE], from: host },
    { id: "m4", text: "@Other", mentions: ["att_other"], from: att },
  ];
  const one = coalesceMentions(null, msgs.slice(0, 2), "att_me");
  eq(one, {
    anchorId: "m2", sender: "Alex Chen", senderIdentity: "user_host", senderRole: "host",
    text: "@Me Myself can you see this?", everyone: false, count: 1,
  }, "a personal mention becomes a card; ordinary messages do not");
  eq(one && mentionHeadline(one), "Alex mentioned you", "…headlined by first name");
  const two = coalesceMentions(one, msgs.slice(2), "att_me");
  eq([two?.count, two?.anchorId, two?.everyone], [2, "m2", true],
    "later mentions coalesce, anchored on the oldest, and @everyone is flagged");
  eq(two && mentionHeadline(two), "2 mentions", "several are counted");
  eq(coalesceMentions(null, msgs, "user_host"), null, "your own @everyone never notifies you");
  eq(coalesceMentions(one, [msgs[0]], "att_me") === one, true, "nothing new keeps the same card");

  eq(unseenMentions(msgs, "att_me", new Set()), ["m2", "m3"], "unseen mentions of me, by id");
  eq(unseenMentions(msgs, "att_me", new Set(["m2"])), ["m3"], "…minus the ones already seen");

  eq(badgeText(0), null, "no badge for nothing");
  eq(badgeText(3), "3", "a count");
  eq(badgeText(140), "99+", "a capped count");
  eq(badgeText(12, 1), "@", "an unseen mention outranks the count");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
