/* The on-demand video box. A webinar on a box that is down starts it at go-live, and a cold
 * box takes 2-4 minutes to boot (api/internal/api/sfu_box.go): until then the stage has no
 * "Join the webinar" button and the audience stream is not up. The tools wait for it here,
 * saying so, instead of failing after a minute (24 Oct: the first run of the day did). */
import { timed } from "./client.mjs";
import { sleep, stamp } from "./args.mjs";

/** The default for --box-wait: long enough for a cold boot plus the stage joining. */
export const BOX_WAIT_MS = 360_000;

/** GET /api/webinars/{slug}/server -> { state: ready|starting|failed, message, sinceSec, etaSec } or null. */
export async function videoServerStatus(api, slug, signal) {
  const r = await timed(`${api}/webinars/${encodeURIComponent(slug)}/server`, { signal, timeoutMs: 10_000 });
  if (!r.ok) return null;
  try {
    return JSON.parse(r.body);
  } catch {
    return null;
  }
}

/** One progress line, e.g. "waiting for the video server (starting, 95 s so far, about 40 s left)". */
export function boxProgress(st, waitedMs) {
  const bits = [st?.state ?? "unknown", `${Math.round(waitedMs / 1000)} s so far`];
  if (st?.etaSec) bits.push(`about ${st.etaSec} s left`);
  return `waiting for the video server (${bits.join(", ")})${st?.message ? `: ${st.message}` : ""}`;
}

/* waitForVideoServer polls the status until it is ready (or failed, or timeoutMs has passed),
 * logging a progress line when it starts waiting and every `everyMs` after. Resolves the last
 * status; null when the endpoint answered nothing usable (an instance without a managed box),
 * which callers treat as ready. */
export async function waitForVideoServer({ api, slug, timeoutMs = BOX_WAIT_MS, everyMs = 15_000, pollMs = 3000, log = console.log, signal }) {
  const t0 = Date.now();
  let lastLog = -Infinity;
  let st = null;
  for (;;) {
    st = await videoServerStatus(api, slug, signal).catch(() => null);
    if (!st || st.state === "ready" || st.state === "failed") break;
    const waited = Date.now() - t0;
    if (waited - lastLog >= everyMs) {
      log(`${stamp()} ${boxProgress(st, waited)}`);
      lastLog = waited;
    }
    if (waited >= timeoutMs || signal?.aborted) break;
    await sleep(pollMs, signal);
  }
  if (st?.state === "ready" && lastLog > -Infinity) log(`${stamp()} video server ready after ${Math.round((Date.now() - t0) / 1000)} s`);
  if (st?.state === "failed") log(`${stamp()} WARNING the video server failed to start: ${st.message ?? ""}`);
  return st;
}
