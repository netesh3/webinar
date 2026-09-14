/* Tests for how the host's roster is sectioned.
 *
 * Run with `make test-web`.
 *
 * A live room will not show you a raised-hand queue sorted by name, or a search
 * box that appears for three people — those are the cases this exists for.
 */

import type { LiveParticipant } from "./api-types.ts";
import type { RaisedHand } from "./realtime.ts";
import {
  matchRosterQuery,
  partitionHostRoster,
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

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
