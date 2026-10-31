/* Calling's decisions (lib/calls.ts).
 *
 * Run: node --experimental-strip-types --no-warnings lib/calls.test.mts
 */

import {
  applyCallEvent,
  avatarOrNull,
  callCardLayout,
  callerStatusLabel,
  contactQueryKind,
  isSitePath,
  parseCallEvent,
  ringSchedule,
  RING_PERIOD_S,
  secondsLeft,
  type IncomingCall,
} from "./calls.ts";
import type { IncomingCallEvent } from "./api-types.ts";

let passed = 0;
let failed = 0;

function ok(label: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? "\n        " + detail : ""}`);
  }
}

const NOW = Date.parse("2026-10-31T10:00:00Z");
const IN_45 = "2026-10-31T10:00:45Z";

const ring = {
  type: "incoming_call",
  callId: "c1",
  callerName: "Asha",
  callerAvatarUrl: null,
  meetingSlug: "asha-and-ravi",
  topic: "Asha and Ravi",
  joinUrl: "/host/asha-and-ravi/room",
  expiresAt: IN_45,
};

// ---- parsing
const parsed = parseCallEvent(JSON.stringify(ring));
ok("incoming_call from the stream", parsed?.type === "incoming_call" && parsed.callId === "c1", JSON.stringify(parsed));
ok("null avatar stays null", parsed?.type === "incoming_call" && parsed.callerAvatarUrl === null);
// The same event as push data: every value a string, "" for null.
const fromPush = parseCallEvent({ ...ring, callerAvatarUrl: "", kind: "incoming_call", url: "/x", tag: "call-c1" });
ok("push data parses the same", fromPush?.type === "incoming_call" && fromPush.callerAvatarUrl === null && fromPush.joinUrl === ring.joinUrl);
ok("https avatar kept", (parseCallEvent({ ...ring, callerAvatarUrl: "https://lh3.example/p.jpg" }) as IncomingCallEvent).callerAvatarUrl === "https://lh3.example/p.jpg");
ok("http avatar dropped", avatarOrNull("http://x/p.jpg") === null && avatarOrNull("javascript:alert(1)") === null);
for (const bad of ["https://evil.example/room", "//evil.example/room", "javascript:alert(1)", "/\\evil", ""]) {
  ok(`joinUrl ${JSON.stringify(bad)} refused`, parseCallEvent({ ...ring, joinUrl: bad }) === null);
}
ok("site path", isSitePath("/host/x/room") && !isSitePath("//x") && !isSitePath(undefined));
ok("no callId refused", parseCallEvent({ ...ring, callId: "" }) === null);
ok("bad expiry refused", parseCallEvent({ ...ring, expiresAt: "soon" }) === null);
ok("unknown type refused", parseCallEvent({ ...ring, type: "something_else" }) === null);
ok("not JSON refused", parseCallEvent("{nope") === null && parseCallEvent(null) === null && parseCallEvent(7) === null);
const longName = parseCallEvent({ ...ring, callerName: "x".repeat(500) }) as IncomingCallEvent;
ok("long name clamped", longName.callerName.length === 80 && longName.callerName.endsWith("…"));
ok("empty name reads Someone", (parseCallEvent({ ...ring, callerName: "  " }) as IncomingCallEvent).callerName === "Someone");
const ended = parseCallEvent('{"type":"call_ended","callId":"c1","state":"declined"}');
ok("call_ended", ended?.type === "call_ended" && ended.state === "declined");
ok("call_ended with a made-up state refused", parseCallEvent({ type: "call_ended", callId: "c1", state: "ringing" }) === null);

// ---- time and the list of rings
ok("45 s left", secondsLeft(IN_45, NOW) === 45);
ok("rounds up", secondsLeft(IN_45, NOW + 44_100) === 1);
ok("none left after", secondsLeft(IN_45, NOW + 46_000) === 0 && secondsLeft("bad", NOW) === 0);
const one = applyCallEvent([], parsed!, NOW);
ok("a ring is added", one.length === 1);
ok("the same ring twice is one", applyCallEvent(one, parsed!, NOW).length === 1);
ok("call_ended removes it", applyCallEvent(one, ended!, NOW).length === 0);
ok("an expired ring is not added", applyCallEvent([], parsed!, NOW + 60_000).length === 0);
const two = applyCallEvent(one, { ...(parsed as IncomingCall), callId: "c2" }, NOW);
ok("newest last", two.length === 2 && two[1].callId === "c2");
ok("expired ones fall out on the next event", applyCallEvent(two, ended!, NOW + 60_000).length === 0);

// ---- labels and layout
ok("ringing label counts down", callerStatusLabel("ringing", 12) === "Ringing… 12s");
ok("missed reads no answer", callerStatusLabel("missed") === "No answer");
ok("declined", callerStatusLabel("declined") === "Declined");
ok("phone is full screen", callCardLayout(390, true) === "fullscreen");
ok("tablet portrait full screen", callCardLayout(820, true) === "fullscreen");
ok("desktop corner", callCardLayout(1440, false) === "corner");
ok("narrow desktop window full screen", callCardLayout(500, false) === "fullscreen");

// ---- contact queries mirror the server's looksLikeEmail
ok("empty", contactQueryKind("  ") === "empty");
ok("email", contactQueryKind("ravi@example.com") === "email");
ok("partial address is a name search", contactQueryKind("ravi@") === "name" && contactQueryKind("ravi@example") === "name");
ok("name", contactQueryKind("Ravi") === "name");

// ---- ringtone
const tones = ringSchedule();
ok("two bursts inside one period", tones.length === 2 && tones.every((t) => t.at + t.duration < RING_PERIOD_S));
ok("two-tone", tones.every((t) => t.freqs[0] === 440 && t.freqs[1] === 480));

console.log(`calls: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
