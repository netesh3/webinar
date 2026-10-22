/* Tests for how the host's roster is sectioned.
 *
 * Run with `make test-web`.
 *
 * A live room will not show you a raised-hand queue sorted by name, or a search
 * box that appears for three people — those are the cases this exists for.
 */

import type { LiveParticipant, LiveRoom } from "./api-types.ts";
import type { RaisedHand } from "./realtime.ts";
import {
  handWaitLabel,
  matchRosterQuery,
  mergeRosterSnapshot,
  rosterConnectionLabel,
  normalizeRosterText,
  partitionHostRoster,
  rosterBadge,
  withLocalOnRoster,
  ROSTER_SEARCH_AFTER,
  shouldShowRosterSearch,
} from "./roster.ts";

let failures = 0;
let checks = 0;

function ok(condition: boolean, what: string, detail = ""): void {
  checks++;
  if (condition) return;
  failures++;
  console.log(`  FAIL  ${what}${detail ? `\n        ${detail}` : ""}`);
}

function eq<T>(actual: T, expected: T, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, what, a === e ? "" : `got ${a}\n        want ${e}`);
}

function person(
  identity: string,
  name: string,
  extra: Partial<LiveParticipant> = {},
): LiveParticipant {
  return {
    identity,
    name,
    role: "attendee",
    joinedAt: "2026-01-01T00:00:00Z",
    publishing: [],
    audioMuted: true,
    hidden: false,
    canPublish: false,
    canSpeak: false,
    audioOnly: false,
    mutedByHost: false,
    coHost: false,
    ...extra,
  };
}

console.log("\nshouldShowRosterSearch");

{
  eq(shouldShowRosterSearch(3, ""), false, "a short room has no search box");
  eq(
    shouldShowRosterSearch(ROSTER_SEARCH_AFTER, ""),
    true,
    "a long room does",
  );
  eq(
    shouldShowRosterSearch(2, "ana"),
    true,
    "…and so does a short room the host is already filtering",
  );
}

console.log("\nmatchRosterQuery");

{
  const ana = person("att_1", "Ana Pérez");
  ok(matchRosterQuery(ana, ""), "an empty query matches everyone");
  ok(matchRosterQuery(ana, "pérez"), "name is matched, case-insensitively");
  ok(matchRosterQuery(ana, "ATT_1"), "identity is matched too — names collide");
  ok(!matchRosterQuery(ana, "bo"), "a miss is a miss");
  ok(matchRosterQuery(ana, "perez"), "accents are ignored — 'perez' finds 'Pérez'");
  ok(matchRosterQuery(ana, "PEREZ"), "…in any case");
  ok(matchRosterQuery(ana, "  ana   pérez "), "extra whitespace does not turn a hit into a miss");
  ok(matchRosterQuery(ana, "pérez ana"), "words match in any order");
  ok(matchRosterQuery(ana, "ana p"), "a first name plus an initial narrows");
  ok(!matchRosterQuery(ana, "ana bo"), "every word has to match, not just one");
  ok(matchRosterQuery(ana, "   "), "a blank query matches everyone");
  ok(
    matchRosterQuery({ name: "", identity: "att_9" }, "att_9"),
    "a nameless participant is still found by identity",
  );
}

console.log("\nnormalizeRosterText");

{
  eq(normalizeRosterText("  José  Müller "), "jose muller", "strips accents, case and padding");
  eq(normalizeRosterText(undefined), "", "tolerates a missing name");
}

console.log("\npartitionHostRoster");

{
  const host = person("user_h", "Host", { role: "host", canPublish: true, canSpeak: true });
  const co = person("user_c", "Co", {
    role: "panelist",
    coHost: true,
    canPublish: true,
    canSpeak: true,
  });
  const pan = person("user_p", "Pan", { role: "panelist", canPublish: true, canSpeak: true });
  const ana = person("att_a", "Ana");
  const bo = person("att_b", "Bo");
  const cy = person("att_c", "Cy");

  const hands: RaisedHand[] = [
    { identity: "att_c", name: "Cy", at: 3_000 },
    { identity: "att_a", name: "Ana", at: 1_000 },
    { identity: "att_b", name: "Bo", at: 2_000 },
  ];

  const { raised, panelists, attendees } = partitionHostRoster(
    [bo, pan, host, cy, ana, co],
    hands,
  );

  eq(
    raised.map((p) => p.identity),
    ["att_a", "att_b", "att_c"],
    "raised hands are oldest-first, not alphabetical",
  );
  eq(
    panelists.map((p) => p.identity),
    ["user_h", "user_c", "user_p"],
    "the stage is host, then co-host, then panelists",
  );
  eq(
    attendees.map((p) => p.identity),
    ["att_a", "att_b", "att_c"],
    "attendees stay in their own section, still listed while their hand is up",
  );
}

{
  const ghost: RaisedHand = { identity: "gone", name: "Left", at: 1 };
  const ana = person("att_a", "Ana");
  eq(
    partitionHostRoster([ana], [ghost]).raised.map((p) => p.identity),
    [],
    "a hand whose owner is not in this list (search, or they left) is dropped",
  );
}

console.log("\nwithLocalOnRoster");

{
  const ana = person("att_a", "Ana");
  const injected = withLocalOnRoster([ana], {
    identity: "user_h",
    name: "Host",
    role: "host",
  });
  eq(
    injected.map((p) => p.identity),
    ["user_h", "att_a"],
    "the host is prepended when the SFU list has not caught up",
  );
  ok(
    injected[0].role === "host",
    "the injected row is a host, so they land in Panelists",
  );
}

{
  const host = person("user_h", "Host", { role: "host", canPublish: true, canSpeak: true });
  const again = withLocalOnRoster([host], {
    identity: "user_h",
    name: "Host",
    role: "host",
  });
  eq(
    again.map((p) => p.identity),
    ["user_h"],
    "an already-listed host is not duplicated",
  );
}

console.log("\nrosterBadge");
eq(rosterBadge(person("user_h", "H", { role: "host" })), { label: "Host", tone: "stage" }, "host");
eq(
  rosterBadge(person("user_c", "C", { role: "panelist", coHost: true })),
  { label: "Co-host", tone: "stage" },
  "a co-host outranks panelist",
);
eq(
  rosterBadge(person("user_p", "P", { role: "panelist" })),
  { label: "Panelist", tone: "neutral" },
  "panelist",
);
eq(
  rosterBadge(person("att_s", "S", { role: "panelist", audioOnly: true })),
  { label: "Speaker", tone: "neutral" },
  "an attendee allowed to speak is a Speaker, not a Panelist",
);
eq(rosterBadge(person("att_a", "A")), null, "attendees get no badge");

console.log("\nhandWaitLabel");
{
  const t = 1_700_000_000_000;
  eq(handWaitLabel(t, t + 30_000), "just now", "under a minute");
  eq(handWaitLabel(t, t + 5 * 60_000 + 59_000), "5 min", "whole minutes, rounded down");
  eq(handWaitLabel(t, t + 125 * 60_000), "2 h 5 min", "hours past the hour");
  eq(handWaitLabel(t, t - 10_000), "just now", "a clock slightly behind never goes negative");
}

console.log("\nrosterConnectionLabel");
eq(rosterConnectionLabel(person("att_e", "E", { via: "stream" })), "Watching via stream", "edge viewer");
eq(rosterConnectionLabel(person("att_l", "L", { via: "limited" })), "Limited connection", "video down, still polling");
eq(rosterConnectionLabel(person("att_a", "A")), null, "on the video server: nothing to say");

console.log("\nmergeRosterSnapshot");
{
  const room = (participants: LiveParticipant[], extra: Partial<LiveRoom> = {}): LiveRoom => ({
    room: "webinar_x",
    status: "live",
    controls: {} as LiveRoom["controls"],
    participants,
    attendees: participants.filter((p) => p.role === "attendee").length,
    onStage: participants.filter((p) => p.role !== "attendee").length,
    ...extra,
  });
  const host = person("user_h", "Host", { role: "host" });
  const sfuBob = person("att_bob", "Bob");
  const streamAl = person("att_al", "Al", { via: "stream" });
  const full = room([host, sfuBob, streamAl]);

  ok(mergeRosterSnapshot(null, full) === full, "a full read with no duplicates is taken as is");

  const partial = room([person("att_al", "Al", { via: "stream" }), person("att_cy", "Cy", { via: "stream" })], {
    partial: true,
  });
  const merged = mergeRosterSnapshot(full, partial);
  eq(
    merged.participants.map((p) => p.identity),
    ["user_h", "att_bob", "att_al", "att_cy"],
    "a partial read keeps the last video-server rows and takes the new viewers",
  );
  eq([merged.attendees, merged.onStage], [3, 1], "counts recomputed from the merged rows");
  eq(
    mergeRosterSnapshot(full, room([streamAl], { partial: true })).participants.filter((p) => p.identity === "att_al").length,
    1,
    "a viewer already listed is not doubled",
  );
  eq(
    mergeRosterSnapshot(null, partial).participants.map((p) => p.identity),
    ["att_al", "att_cy"],
    "a first read that is partial shows what it has",
  );

  // Duplicates in one read (the video server and a viewer row for the same person): the
  // first, the video server's, wins and the counts follow.
  const dup = room([sfuBob, person("att_bob", "Bob", { via: "limited" })], { attendees: 2 });
  const deduped = mergeRosterSnapshot(null, dup);
  eq(deduped.participants.map((p) => p.via ?? ""), [""], "one row per identity, the video server's");
  eq(deduped.attendees, 1, "and counted once");

  // After a partial read, the next full one replaces it: somebody who left the stage meanwhile is gone.
  const later = room([host, streamAl]);
  eq(
    mergeRosterSnapshot(merged, later).participants.map((p) => p.identity),
    ["user_h", "att_al"],
    "a full read drops rows the partial one carried over",
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
