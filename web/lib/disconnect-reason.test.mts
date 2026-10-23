/* Tests for lib/disconnect-reason.ts, against livekit-client's real DisconnectReason values.
 * Run with `make test-web`. */

import { DisconnectReason } from "livekit-client";
import { classifyDisconnect, disconnectVerdict } from "./disconnect-reason.ts";

let failures = 0;
let checks = 0;

function eq<T>(actual: T, expected: T, what: string): void {
  checks++;
  if (actual === expected) return;
  failures++;
  console.log(`  FAIL  ${what}\n        got ${String(actual)}, want ${String(expected)}`);
}

const idle = { established: true, leaving: false, over: false };

// Not this instance's connection (yet): a failed connect, or the previous instance's cleanup.
for (const reason of [DisconnectReason.UNKNOWN_REASON, DisconnectReason.JOIN_FAILURE, DisconnectReason.USER_REJECTED, undefined]) {
  eq(disconnectVerdict({ ...idle, established: false, reason }), "ignore", `a failed connect (${String(reason)}) is left to the catch`);
}
eq(
  disconnectVerdict({ ...idle, established: false, reason: DisconnectReason.CLIENT_INITIATED }),
  "ignore",
  "the previous effect's cleanup disconnect (a stage reconnect) is not a network drop",
);

// Leave pressed: leaving, even though livekit says CLIENT_INITIATED like everything else.
eq(disconnectVerdict({ ...idle, leaving: true, reason: DisconnectReason.CLIENT_INITIATED }), "left", "Leave is leaving");
eq(disconnectVerdict({ ...idle, leaving: true, over: true }), "left", "Leave wins over a session that is ending");
eq(
  disconnectVerdict({ ...idle, leaving: true, established: false, reason: DisconnectReason.JOIN_FAILURE }),
  "left",
  "Leave pressed while a connect is in flight is leaving, whatever that connect does",
);

// livekit's own disconnects that are not the person leaving.
eq(disconnectVerdict({ ...idle, reason: undefined }), "lost", "livekit giving up its reconnect (no reason) is retried");
eq(disconnectVerdict({ ...idle, reason: DisconnectReason.CLIENT_INITIATED }), "lost", "Chrome freezing a background tab / pagehide is retried");
eq(disconnectVerdict({ ...idle, reason: DisconnectReason.STATE_MISMATCH }), "lost", "a state mismatch is retried");
eq(disconnectVerdict({ ...idle, reason: DisconnectReason.SIGNAL_CLOSE }), "lost", "a closed signal connection is retried");

// Decisions somebody made: never retried.
eq(disconnectVerdict({ ...idle, reason: DisconnectReason.ROOM_DELETED }), "ended", "room deleted ends it");
eq(disconnectVerdict({ ...idle, reason: DisconnectReason.PARTICIPANT_REMOVED }), "removed", "removed by the host");
eq(disconnectVerdict({ ...idle, reason: DisconnectReason.DUPLICATE_IDENTITY }), "duplicate", "the same key in another tab");
eq(disconnectVerdict({ ...idle, over: true, reason: undefined }), "ended", "a session being ended is not a network drop");

// classifyDisconnect itself is unchanged from what webinar-room.tsx had.
eq(classifyDisconnect(DisconnectReason.CLIENT_INITIATED), null, "classifyDisconnect: CLIENT_INITIATED is null");
eq(classifyDisconnect(undefined), null, "classifyDisconnect: undefined is null");
eq(classifyDisconnect(DisconnectReason.SERVER_SHUTDOWN), "ended", "classifyDisconnect: server shutdown ends");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
