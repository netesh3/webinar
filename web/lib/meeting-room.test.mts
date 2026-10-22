/* Tests for what a meeting's room does differently from a webinar's.
 *
 * Run with `make test-web`.
 *
 * The cases a two-person test call does not show: a webinar room losing a tool because the
 * meeting filter ran on it, a refresh switching a guest's camera off, and a forged lobby
 * packet getting a number into the host's header.
 */

import type { LobbyEntry } from "./api-types.ts";
import type { ToolId } from "./tools.ts";
import {
  admitAllMessage,
  lobbyArrivals,
  lobbyLabel,
  lobbyToastText,
  lobbyWaitingFrom,
  meetingDoorFor,
  meetingFullMessage,
  meetingRejoinEntry,
  roomExitCopy,
  meetingTools,
  prejoinMedia,
  sortLobby,
  usesMeetingEntry,
} from "./meeting-room.ts";

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

const entry = (id: string, name: string, requestedAt: string): LobbyEntry => ({ id, name, requestedAt });

console.log("meetingTools");
{
  const all: ToolId[] = ["chat", "qa", "polls", "participants", "hand", "host", "youtube", "linkedin", "instagram", "facebook", "whiteboard"];
  eq(meetingTools(all, false), all, "a webinar keeps every tool, in order");
  eq(
    meetingTools(all, true),
    ["chat", "qa", "polls", "participants", "hand", "host", "whiteboard"],
    "a meeting keeps raise hand and drops only the stream destinations",
  );
  ok(meetingTools(all, false) !== all, "a copy, so a caller sorting it cannot reorder the input");
}

console.log("\nentry media");
{
  ok(usesMeetingEntry(true, "panelist"), "a meeting guest uses the meeting entry");
  ok(!usesMeetingEntry(true, "host"), "the host keeps their own preferences");
  ok(!usesMeetingEntry(undefined, "panelist"), "a webinar panelist keeps theirs");
  ok(!usesMeetingEntry(false, "attendee"), "and so does a webinar attendee");

  const unmutedDark = { micEnabled: true, cameraEnabled: false };
  eq(prejoinMedia(unmutedDark, true), { micEnabled: false, cameraEnabled: true }, "meeting: mic muted, camera on");
  eq(prejoinMedia(unmutedDark, false), unmutedDark, "webinar: the remembered preference, unchanged");

  const saved = { mic: true, camera: false, sharing: false, at: 1 };
  eq(meetingRejoinEntry(saved, false), { micEnabled: true, cameraEnabled: false }, "a refresh comes back as it was");
  eq(meetingRejoinEntry(saved, true), { micEnabled: false, cameraEnabled: false }, "a host mute still wins over the saved mic");
  eq(meetingRejoinEntry(null, false), { micEnabled: false, cameraEnabled: true }, "nothing saved: the meeting's entry");
}

console.log("\nlobbyWaitingFrom");
{
  eq(lobbyWaitingFrom({ kind: "lobby", waiting: 3, at: 1 }), 3, "the server's packet");
  eq(lobbyWaitingFrom({ kind: "lobby", waiting: 0 }), 0, "an empty lobby is a real answer");
  eq(lobbyWaitingFrom({ kind: "chat", waiting: 3 }), null, "another kind");
  eq(lobbyWaitingFrom({ kind: "lobby", waiting: "3" }), null, "a string");
  eq(lobbyWaitingFrom({ kind: "lobby", waiting: -1 }), null, "negative");
  eq(lobbyWaitingFrom({ kind: "lobby", waiting: 1.5 }), null, "fractional");
  eq(lobbyWaitingFrom({ kind: "lobby" }), null, "missing");
  eq(lobbyWaitingFrom({ kind: "lobby", waiting: 1e9 }), 10_000, "clamped");
}

console.log("\nlobby list");
{
  const a = entry("a", "Asha", "2026-10-22T10:00:00Z");
  const b = entry("b", "Bilal", "2026-10-22T10:01:00Z");
  const c = entry("c", "Chen", "2026-10-22T09:59:00Z");
  eq(lobbyArrivals(new Set(["a"]), [a, b]).map((e) => e.id), ["b"], "only the ones not yet announced");
  eq(lobbyArrivals(new Set(["a", "b"]), [a, b]), [], "the same queue again announces nobody");
  eq(sortLobby([a, b, c]).map((e) => e.id), ["c", "a", "b"], "oldest first, the order admit-all takes");
  eq(sortLobby([entry("x", "X", "garbage"), a]).map((e) => e.id), ["a", "x"], "a bad time sorts last");

  eq(lobbyToastText([a]), "Asha is waiting to join.", "one");
  eq(lobbyToastText([a, b]), "Asha and Bilal are waiting to join.", "two");
  eq(lobbyToastText([a, b, c]), "Asha and 2 others are waiting to join.", "more");
  eq(lobbyToastText([]), "", "nobody");
  eq(lobbyLabel(4), "Waiting (4)", "label");
}

console.log("\nmessages");
{
  eq(
    meetingFullMessage("This meeting is full: it holds 10 people at once, including the host."),
    "Meeting is full (10). Ask an admin to raise it.",
    "the cap from the server's message",
  );
  eq(meetingFullMessage(undefined), "Meeting is full. Ask an admin to raise it.", "no message");
  eq(admitAllMessage({ admitted: 3, left: 0 }), "Let in 3 people.", "everyone");
  eq(admitAllMessage({ admitted: 1, left: 0 }), "Let in 1 person.", "one");
  eq(
    admitAllMessage({ admitted: 2, left: 1 }),
    "Let in 2 people. The meeting is full, so 1 person is still waiting.",
    "as many as fit",
  );
  eq(admitAllMessage({ admitted: 0, left: 2 }), "Meeting is full. Ask an admin to raise it.", "nobody fit");
  eq(admitAllMessage({ admitted: 0, left: 0 }), "Nobody is waiting.", "nobody there");
}

// The closing screen says "meeting" in a meeting, and a webinar's words are unchanged.
{
  eq(roomExitCopy("ended", true).title, "The meeting has ended", "meeting ended");
  eq(roomExitCopy("ended", false).title, "The webinar has ended", "webinar ended");
  eq(roomExitCopy("removed", true).title, "You were removed from the meeting", "meeting removal");
  for (const reason of ["ended", "removed", "duplicate", "lost"] as const) {
    const c = roomExitCopy(reason, true);
    ok(!/webinar/i.test(c.title + c.body), `meeting ${reason} copy never says webinar`, JSON.stringify(c));
  }
}

// Who is asked their name at a meeting's link.
{
  eq(meetingDoorFor({ status: "anonymous" }, "u1"), "form", "signed out: the name form");
  eq(meetingDoorFor({ status: "loading" }, "u1"), "wait", "session loading: no form flash");
  eq(meetingDoorFor({ status: "signed-in", accountId: "u2" }, "u1"), "auto", "signed in: knock with the account");
  eq(meetingDoorFor({ status: "signed-in", accountId: "u1" }, "u1"), "host", "the host: their own room");
  eq(meetingDoorFor({ status: "signed-in", accountId: "u1" }, ""), "auto", "host unknown: still a knock");
  eq(meetingDoorFor({ status: "signed-in" }, "u1"), "form", "signed in without an account: the form");
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
