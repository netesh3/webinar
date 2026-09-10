/* Tests for the reconnection ladder.
 *
 * Run with `make test-web`.
 *
 * These exist because the thing they describe cannot be tested in a browser. A real
 * media-path failure is not injectable from a harness: Chrome DevTools network emulation
 * does not apply to WebRTC transport — verified, a 100-second "offline" window left the peer
 * connection untouched — and the SDK's `simulateScenario` needs a handle on the Room that the
 * production build deliberately does not expose. So the browser can only show that a short
 * outage survives; whether the ladder gives up at the right time, and refuses to retry the
 * things that must not be retried, is settled here.
 *
 * What is being protected. From 48 hours of SFU logs on the deployed instance: of 140
 * sessions, 91 ended because somebody pressed Leave and 42 ended with
 * PEER_CONNECTION_DISCONNECTED. The old client answered that second case with a terminal
 * screen and a manual Rejoin button, on the first failure, on a path with ~275 ms of round
 * trip. The drop is the internet; the dead end was ours.
 */

import { planRecovery, RECOVERY_BACKOFF_MS, recoveryWindowMs } from "./recovery.ts";

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

console.log("\nplanRecovery");

/* The reasons that must NEVER be retried, and why each one matters.
 *
 * This is the half that a naive "just reconnect on any disconnect" gets wrong, and every
 * case fails in a distinctly bad way rather than merely uselessly. */
{
  eq(
    planRecovery("removed", 0),
    { action: "give-up" },
    "a host who removed somebody must not have them walk back in",
  );
  eq(
    planRecovery("ended", 0),
    { action: "give-up" },
    "a webinar that has ended must not be rejoined into an empty room",
  );
  /* The worst of the three. Two tabs with one identity take turns evicting each other, so a
   * retry here is an infinite loop that looks to both tabs like the app crashing. */
  eq(
    planRecovery("duplicate", 0),
    { action: "give-up" },
    "a duplicate identity must not be retried — the two tabs would evict each other for ever",
  );
}

// The one that is retried.
{
  eq(
    planRecovery("lost", 0),
    { action: "retry", attempt: 1, delayMs: RECOVERY_BACKOFF_MS[0] },
    "a lost connection is retried, starting with the shortest delay",
  );
  eq(
    planRecovery("lost", 1),
    { action: "retry", attempt: 2, delayMs: RECOVERY_BACKOFF_MS[1] },
    "the second attempt waits longer",
  );
}

// Backoff, not a tight loop.
{
  let increasing = true;
  for (let i = 1; i < RECOVERY_BACKOFF_MS.length; i++) {
    if (RECOVERY_BACKOFF_MS[i] <= RECOVERY_BACKOFF_MS[i - 1]) increasing = false;
  }
  ok(increasing, "each delay is longer than the last", RECOVERY_BACKOFF_MS.join(", "));
  /* The first rung is fast but NOT zero, and both halves of that matter.
   *
   * This used to require >= 500 ms, on the reasoning that an immediate retry just hits the same
   * dead network. True for a mid-call drop — but the same ladder handles a failed FIRST connect,
   * where the usual cause is that the network was not ready a moment ago and the fix is to try
   * again promptly. So the rung came down to 250 ms.
   *
   * The lower bound stays, because zero would be a tight loop against an unreachable server:
   * five attempts with no gap between them is one attempt with extra logging. */
  ok(
    RECOVERY_BACKOFF_MS[0] >= 100 && RECOVERY_BACKOFF_MS[0] <= 500,
    "the first retry is prompt but not a tight loop",
    `${RECOVERY_BACKOFF_MS[0]} ms`,
  );
  /* And it is genuinely faster than the second, which is what makes the ladder asymmetric
   * rather than merely short. A flat ladder would pass every other assertion here. */
  ok(
    RECOVERY_BACKOFF_MS[1] >= RECOVERY_BACKOFF_MS[0] * 2,
    "the second rung backs off properly instead of retrying at the same rate",
    `${RECOVERY_BACKOFF_MS[0]} then ${RECOVERY_BACKOFF_MS[1]} ms`,
  );
  /* Long enough to cover the outages that actually happen — a lift, a short tunnel, a
   * wifi-to-cellular handoff — and short enough that somebody staring at a frozen webinar is
   * told the truth rather than left watching a spinner. */
  const window = recoveryWindowMs();
  ok(window >= 10_000, "the ladder spans at least ten seconds", `${window} ms`);
  ok(window <= 40_000, "…and gives up inside forty", `${window} ms`);
}

/* Exhaustion. The property here is that it terminates: a ladder that never gives up is not
 * resilience, it is a session that can never be escaped, and the person is owed the terminal
 * screen once the network really is gone. */
{
  eq(
    planRecovery("lost", RECOVERY_BACKOFF_MS.length),
    { action: "give-up" },
    "after the last attempt it gives up rather than looping",
  );
  eq(
    planRecovery("lost", RECOVERY_BACKOFF_MS.length + 5),
    { action: "give-up" },
    "…and stays given up past the end",
  );

  // Walked end to end, which is what the component actually does.
  let attempts = 0;
  let retries = 0;
  let total = 0;
  for (let i = 0; i < 50; i++) {
    const plan = planRecovery("lost", attempts);
    if (plan.action === "give-up") break;
    retries++;
    total += plan.delayMs;
    attempts = plan.attempt;
  }
  eq(retries, RECOVERY_BACKOFF_MS.length, "walking the ladder makes exactly as many attempts as there are rungs");
  eq(total, recoveryWindowMs(), "…and spends exactly the advertised window doing it");
}

/* Attempt numbers are 1-based and contiguous, because they are shown to a person:
 * "Reconnecting… (2 of 4)". An off-by-one here is a banner that counts to five out of four. */
{
  const seen: number[] = [];
  let attempts = 0;
  for (;;) {
    const plan = planRecovery("lost", attempts);
    if (plan.action === "give-up") break;
    seen.push(plan.attempt);
    attempts = plan.attempt;
  }
  eq(
    seen,
    RECOVERY_BACKOFF_MS.map((_, i) => i + 1),
    "the attempt numbers shown to the user run 1..n with no gaps",
  );
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}  ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
