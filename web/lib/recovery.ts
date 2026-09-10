/* What to do when the media connection goes away.
 *
 * Extracted from the room component so it can be tested. That is not a stylistic preference:
 * a real media-path failure cannot be injected from outside a browser — Chrome DevTools
 * network emulation does not apply to WebRTC transport, and the SDK's own simulateScenario
 * needs a handle on the Room that production deliberately does not expose. So the ladder is
 * verified here, deterministically, and what the browser proves is only that a short outage
 * now survives.
 *
 * The measured problem this solves, from 48 hours of SFU logs on the deployed instance: of
 * 140 sessions, 42 ended with PEER_CONNECTION_DISCONNECTED. The same logs show the SDK
 * recovering most drops by itself (170 "ice reconnected or switched pair", 74 "resuming RTC
 * session"), so this only runs when the SDK has already given up — and the old behaviour at
 * that point was a terminal screen with a manual Rejoin button.
 */

/** Why a participant is no longer connected. Mirrors ExitReason in the room. */
export type LostReason = "ended" | "removed" | "duplicate" | "lost";

export type Recovery =
  | { action: "retry"; attempt: number; delayMs: number }
  | { action: "give-up" };

/* Backoff, not a tight loop — but the FIRST rung is nearly immediate, and that asymmetry is
 * deliberate.
 *
 * It used to open at a flat 1 s. Backoff is right for the case this ladder was written for: a
 * network that is genuinely gone, where hammering it does not bring it back sooner. But the
 * same ladder is also used when the very first connect() throws, and there the usual cause is
 * that the network was not ready yet a moment ago — a case a retry 250 ms later fixes, and
 * where a full second is a second of somebody staring at a spinner for nothing.
 *
 * So: try again almost at once, then back off properly if that did not work. Five attempts
 * spanning about fifteen seconds, which covers a lift, a short tunnel and a wifi-to-cellular
 * handoff. One more attempt than before, and the first one four times sooner.
 *
 * Worth knowing where this sits: livekit-client does its own ICE restart and session resume
 * first, and only emits Disconnected once it has given up. So on a mid-call drop several
 * seconds have already passed and this rung is a small part of the wait. On a failed initial
 * connect it is the whole wait, which is why it is short.
 */
export const RECOVERY_BACKOFF_MS = [250, 1_000, 2_000, 4_000, 8_000];

/**
 * planRecovery decides whether a disconnect is worth retrying.
 *
 * `attemptsSoFar` counts retries already spent, so the first call for a fresh drop passes 0.
 */
export function planRecovery(reason: LostReason, attemptsSoFar: number): Recovery {
  /* Only "lost" is retried, and the distinction is the whole point. Being removed by the
   * host, the room being deleted, and the same identity signing in elsewhere are decisions
   * somebody made — retrying would either fail identically or fight the other tab for the
   * identity, which is a loop that looks like a crash. "lost" is the one that means the
   * network, and networks come back. */
  if (reason !== "lost") return { action: "give-up" };
  if (attemptsSoFar >= RECOVERY_BACKOFF_MS.length) return { action: "give-up" };
  return {
    action: "retry",
    attempt: attemptsSoFar + 1,
    delayMs: RECOVERY_BACKOFF_MS[attemptsSoFar],
  };
}

/** Total time the ladder will spend before surrendering, for the copy that says so. */
export function recoveryWindowMs(): number {
  return RECOVERY_BACKOFF_MS.reduce((a, b) => a + b, 0);
}
