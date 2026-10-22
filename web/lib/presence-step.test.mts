/* Tests for replaying a presence poll as stage-invite packets (lib/presence-step.ts).
 *
 * Run with `make test-web`. A dropped LiveKit connection cannot be arranged in a browser on
 * demand, so this is where "the invite shows once, and goes when it has gone" is checked. */

import { presenceInviteStep, presencePacket } from "./presence-step.ts";

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

const invite = { invite: { audioOnly: true, recording: true } };
const none = {};

console.log("\npresenceInviteStep");
eq(presenceInviteStep(false, invite), "show", "a new invite is shown");
eq(presenceInviteStep(true, invite), null, "an invite already shown is not shown again on every poll");
eq(presenceInviteStep(true, none), "clear", "an invite that has gone is cleared");
eq(presenceInviteStep(false, none), null, "nothing to say");

console.log("\npresencePacket");
eq(
  presencePacket("show", "att_A", invite, 5),
  { kind: "stage-invite", identity: "att_A", audioOnly: true, recording: true, at: 5 },
  "the invite packet, as the server sends it",
);
eq(
  presencePacket("show", "att_A", { invite: { audioOnly: false, recording: false } }, 5),
  { kind: "stage-invite", identity: "att_A", audioOnly: false, recording: false, at: 5 },
  "camera and mic, not recording",
);
eq(
  presencePacket("clear", "att_A", none, 6),
  { kind: "stage-invite-clear", identity: "att_A", at: 6 },
  "the clear packet",
);

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
