/* Backup caller for POST /api/internal/tick (deploy/ops-box/README.md, "Backup caller").
 *
 * The ops droplet is the primary caller. The API takes a lease per pass, so this worker
 * calling in the same minute is harmless: one answers {"status":"ran"}, the other "busy".
 * Both are success. The secret is never logged.
 */

export const DEFAULT_TICK_URL =
  "https://webcast-api-65278594492.asia-south1.run.app/api/internal/tick";
export const TIMEOUT_MS = 55_000;

/** buildTickRequest returns the URL and fetch init for one tick call. */
export function buildTickRequest(env, signal) {
  return {
    url: env.TICK_URL || DEFAULT_TICK_URL,
    init: {
      method: "POST",
      headers: { "X-Tick-Secret": env.TICK_SECRET },
      signal,
    },
  };
}

/** isSuccess: HTTP 200 with status "ran" or "busy". */
export function isSuccess(httpStatus, body) {
  if (httpStatus !== 200) return false;
  try {
    const s = JSON.parse(body).status;
    return s === "ran" || s === "busy";
  } catch {
    return false;
  }
}

export async function runTick(env, fetchImpl = fetch) {
  if (!env.TICK_SECRET) {
    console.error("tick: TICK_SECRET is not set; skipping");
    return false;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const { url, init } = buildTickRequest(env, ctrl.signal);
  const started = Date.now();
  try {
    const res = await fetchImpl(url, init);
    const body = await res.text();
    const ok = isSuccess(res.status, body);
    const line = `tick: HTTP ${res.status} ${body.slice(0, 200)} in ${Date.now() - started} ms`;
    (ok ? console.log : console.error)(line);
    return ok;
  } catch (err) {
    const why = err && err.name === "AbortError" ? `timeout after ${TIMEOUT_MS} ms` : String(err);
    console.error(`tick: failed: ${why}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runTick(env));
  },
};
