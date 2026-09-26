/* Tests for chat avatars (initials, colour) and how the panel lays out messages.
 *
 * Run with `make test-web`.
 *
 * The expected colours and initials were printed by the Go originals —
 * store.HueFor and store.InitialsOf in api/internal/store/users.go — so these
 * fail if the port ever drifts from the server.
 */

import { hueFor, initialsOf } from "./avatar.ts";
import { groupChat, recentSpeakers } from "./chat-groups.ts";
import type { ChatMessage, Sender } from "./realtime.ts";

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

console.log("initialsOf");
eq(initialsOf("Netesh Kumar"), "NK", "first letter of first and last name");
eq(initialsOf("Cher"), "C", "a single-word name gives one letter");
eq(initialsOf("Ana-Lucía Moreno"), "AM", "hyphens split words");
eq(initialsOf("jean-luc picard"), "JP", "lower-case names are upper-cased");
eq(initialsOf("Dr. Ngozi Okonjo-Iweala"), "DI", "dots split words, as on the server");
eq(initialsOf("  "), "?", "a blank name gives ?");
eq(initialsOf("élodie"), "É", "non-ASCII first letters survive");

console.log("\nhueFor (matches store.HueFor)");
eq(hueFor("att_7b20"), "#419d25", "attendee identity");
eq(hueFor("host_4f1a"), "#259d4d", "host identity");
eq(hueFor("Netesh Kumar"), "#75259d", "a name seed");
eq(hueFor("ANA@x.io"), "#259d5f", "seeds are lower-cased first");
eq(hueFor(""), "#9b9d25", "an empty seed");

console.log("\ngroupChat");

const ana: Sender = { identity: "att_ana", name: "Ana", role: "attendee" };
const bo: Sender = { identity: "host_bo", name: "Bo", role: "host" };
const T0 = 1_700_000_000_000;
let seq = 0;
function msg(from: Sender, at: number, extra: Partial<ChatMessage> = {}): ChatMessage {
  seq++;
  return {
    kind: "chat",
    id: `m${seq}`,
    from,
    destination: "everyone",
    text: `line ${seq}`,
    at,
    seq,
    ...extra,
  };
}

{
  const chat = [
    msg(bo, T0),
    msg(bo, T0 + 1000),
    msg(bo, T0 + 2000),
    msg(bo, T0 + 3000),
    msg(bo, T0 + 4000),
    msg(ana, T0 + 5000),
  ];
  eq(
    groupChat(chat).map((g) => g.messages.map((m) => m.id)),
    [["m1"], ["m2"], ["m3"], ["m4"], ["m5"], ["m6"]],
    "five sends in a row from one person stay five separate messages",
  );
}
{
  const chat = [
    msg(bo, T0),
    msg(bo, T0 + 1000, { destination: "panelists" }),
    msg(bo, T0 + 2000),
  ];
  eq(
    groupChat(chat).map((g) => [g.from.identity, g.destination, g.messages.length]),
    [["host_bo", "everyone", 1], ["host_bo", "panelists", 1], ["host_bo", "everyone", 1]],
    "each message carries its own sender and audience",
  );
}
eq(groupChat([]), [], "no messages, no groups");

console.log("\nrecentSpeakers");
{
  const me: Sender = { identity: "me", name: "Me", role: "attendee" };
  const cy: Sender = { identity: "att_cy", name: "Cy", role: "attendee" };
  const chat = [msg(cy, T0), msg(ana, T0), msg(me, T0), msg(bo, T0), msg(ana, T0)];
  eq(
    recentSpeakers(chat, 4, "me").map((s) => s.name),
    ["Ana", "Bo"],
    "newest first, deduplicated, without you, within the unseen count",
  );
  eq(recentSpeakers(chat, 99, "me", 2).length, 2, "capped");
  eq(recentSpeakers(chat, 0, "me"), [], "nothing unseen, nobody shown");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
