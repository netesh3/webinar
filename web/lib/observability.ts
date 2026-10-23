/* Front-end observability (Grafana Faro): the one module the rest of the app calls.
 *
 * Faro itself is loaded lazily (components/faro-boot.tsx → lib/faro-init.ts), after the page
 * has loaded, and only when the build has NEXT_PUBLIC_FARO_URL. Until then the calls here are
 * queued (a few, so a join failure in the first second is not lost); without a URL, or on a
 * page Faro is not started on, they do nothing. Never throws: a report must not be able to
 * break the thing it reports on.
 *
 * Privacy: callers pass codes and kinds, never names, emails, join keys or tokens. Whatever
 * they pass still goes through lib/faro-privacy.ts before it is sent.
 */

/** The Faro collector URL, inlined at build time. Public by design (it only accepts beacons). */
export const FARO_URL = process.env.NEXT_PUBLIC_FARO_URL?.trim() ?? "";

export type ReportAttrs = Record<string, string | number | boolean | null | undefined>;

/** The part of Faro's API used here, so this module never imports the SDK itself. */
export type FaroApiLike = {
  pushEvent: (name: string, attributes?: Record<string, string>) => void;
  pushError: (error: Error, options?: { type?: string; context?: Record<string, string> }) => void;
};

const QUEUE_LIMIT = 30;
let api: FaroApiLike | null = null;
let off = FARO_URL === "";
const queue: Array<(a: FaroApiLike) => void> = [];

function attrs(a?: ReportAttrs): Record<string, string> {
  const out: Record<string, string> = {};
  if (!a) return out;
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v).slice(0, 200);
  }
  return out;
}

function run(fn: (a: FaroApiLike) => void) {
  if (off) return;
  if (api) {
    try {
      fn(api);
    } catch {
      /* Reporting is best effort. */
    }
    return;
  }
  if (queue.length < QUEUE_LIMIT) queue.push(fn);
}

/** Called by lib/faro-init.ts once Faro is up: sends what was queued. */
export function attachFaro(a: FaroApiLike) {
  api = a;
  for (const fn of queue.splice(0)) run(fn);
}

/** Faro will not be started on this page (no URL, recorder page, failed to load). */
export function detachFaro() {
  off = true;
  queue.length = 0;
}

/** A named event, e.g. reportEvent("room_join_refused", { door: "attendee", code }). */
export function reportEvent(name: string, a?: ReportAttrs) {
  run((f) => f.pushEvent(name, attrs(a)));
}

/** An error worth seeing on its own (connect and media failures). `name` is the error's type
 *  in Grafana; the message is the original error's, scrubbed before sending. */
export function reportError(name: string, err: unknown, a?: ReportAttrs) {
  run((f) => {
    const message = err instanceof Error ? err.message : String(err ?? "");
    const e = new Error(`${name}: ${message}`.slice(0, 500));
    e.name = name;
    if (err instanceof Error && err.stack) e.stack = err.stack;
    const context = attrs({ ...a, errorName: err instanceof Error ? err.name : typeof err });
    f.pushError(e, { type: name, context });
  });
}
