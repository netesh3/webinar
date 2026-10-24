/* Tests for the "Delete all recordings" confirm gating (lib/recording-purge.ts).
 *
 * Run with `make test-web`.
 */

import { purgeCanStart, purgeConfirmMatches, purgePhaseLabel, purgeRunning } from "./recording-purge.ts";
import type { RecordingPurge, RecordingPurgeStatus } from "./api-types.ts";

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

const run = (phase: string): RecordingPurge => ({
  id: "p1",
  phase,
  requestedBy: "admin@test.dev",
  startedAt: "2026-10-25T10:00:00Z",
  summary: {
    recordings: 0,
    files: 0,
    bytes: 0,
    uploadsAborted: 0,
    clips: 0,
    simulivesAffected: 0,
    recordingsStopped: 0,
  },
});
const status = (recordings: number, latest?: RecordingPurge): RecordingPurgeStatus => ({
  totals: { recordings, bytes: recordings * 1000, clips: 0, uploads: 0 },
  latest,
});

console.log("purgeConfirmMatches");
eq(purgeConfirmMatches("DELETE ALL RECORDINGS"), true, "the exact phrase");
eq(purgeConfirmMatches(""), false, "empty");
eq(purgeConfirmMatches("delete all recordings"), false, "case matters");
eq(purgeConfirmMatches(" DELETE ALL RECORDINGS"), false, "no leading space");
eq(purgeConfirmMatches("DELETE ALL RECORDINGS "), false, "no trailing space");
eq(purgeConfirmMatches("DELETE ALL"), false, "part of it");

console.log("\npurgeCanStart");
eq(purgeCanStart(status(3), "DELETE ALL RECORDINGS", false), true, "typed, something to delete");
eq(purgeCanStart(status(3), "DELETE ALL RECORDING", false), false, "not quite typed");
eq(purgeCanStart(status(3), "DELETE ALL RECORDINGS", true), false, "already running on this page");
eq(purgeCanStart(null, "DELETE ALL RECORDINGS", false), false, "totals not loaded");
eq(purgeCanStart(status(0), "DELETE ALL RECORDINGS", false), false, "nothing to delete");
eq(purgeCanStart(status(0, run("sweeping")), "DELETE ALL RECORDINGS", false), true, "an unfinished run carries on");
eq(purgeCanStart(status(0, run("done")), "DELETE ALL RECORDINGS", false), false, "finished and empty");

console.log("\npurgeRunning");
eq(purgeRunning(undefined), false, "no run");
eq(purgeRunning(run("deleting")), true, "deleting");
eq(purgeRunning(run("done")), false, "done");

console.log("\npurgePhaseLabel");
eq(purgePhaseLabel("done"), "Done", "done");
eq(purgePhaseLabel("sweeping"), "Clearing leftover files from storage", "sweeping");

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
