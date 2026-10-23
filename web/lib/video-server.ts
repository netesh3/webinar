/* The "Starting servers…" waiting screen (api/internal/api/sfu_box.go).
 *
 * The video server for some sessions is created on demand and deleted when idle. A join that
 * finds it down or booting is answered 503 `sfu_starting`; one that has failed to start several
 * times, 503 `sfu_failed`. The host, panelist, attendee and edge-viewer screens all wait the
 * same way: ask the same join again on a timer and go in by themselves when it answers. Only the
 * host (and panelists, who share the stage gate) gets a "Try again" on a failure, which also
 * asks the API to retry at once (POST /api/host/webinars/{slug}/server/retry).
 *
 * Pure: no React, so it runs under node tests. */

export type ServerWait = "starting" | "failed";

export const SERVER_STARTING_TITLE = "Starting servers…";
export const SERVER_FAILED_TITLE = "The video server couldn't start";

/** The wait a join error code means, or null when it is some other refusal. */
export function serverWaitOf(code: string | undefined | null): ServerWait | null {
  if (code === "sfu_starting") return "starting";
  if (code === "sfu_failed") return "failed";
  return null;
}

/** How long to wait before asking again: often while starting, less often once failed (the
 *  API retries with backoff by itself; asking keeps the box wanted). */
export function serverRetryDelayMs(wait: ServerWait): number {
  return wait === "starting" ? 5_000 : 15_000;
}

export type ServerWaitCopy = { title: string; body: string; retry: boolean };

/** What the waiting card says. `stage` is a host or panelist; `waitedSec` how long this
 *  screen has been waiting. */
export function serverWaitCopy(wait: ServerWait, stage: boolean, waitedSec: number): ServerWaitCopy {
  if (wait === "failed") {
    return {
      title: SERVER_FAILED_TITLE,
      body: stage
        ? "We've told the team and it keeps retrying. Try again in a minute, or wait here: you'll go in by yourself once it's up."
        : "The organiser's team has been told and it keeps retrying. Stay on this page: you'll join by yourself once it's up.",
      retry: stage,
    };
  }
  const late = waitedSec >= 240;
  return {
    title: SERVER_STARTING_TITLE,
    body: late
      ? "This is taking longer than usual (about 2 minutes). Still trying; you'll go in by yourself when it's ready."
      : stage
        ? "(about 2 minutes) The video server starts when a session needs it. You'll go straight into your room when it's up."
        : "(about 2 minutes) You'll join by yourself when it's ready. No need to refresh.",
    retry: false,
  };
}
