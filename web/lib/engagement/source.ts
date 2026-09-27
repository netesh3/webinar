/* Where the Engagement page gets its data: one interface, two adapters.
 *
 * `fixtureSource()` (here) answers from the seeded sample webinar with the server's paging
 * semantics, so the page renders with no backend (dev bypass, /mock/engagement).
 * `apiSource(slug)` lives in api-source.ts, apart from this file, so node can test this one
 * without resolving the app's HTTP client. Components only ever see the interface. */

import type { EngagementAttendeeDetail, EngagementAttendeePage, EngagementSummary } from "../api-types.ts";
import { summarise } from "./fixture-summary.ts";
import { generateWorld, AXIS, type FixtureWorld } from "./fixtures.ts";
import { pageOf, type AttendeeQuery } from "./query.ts";

export interface EngagementSource {
  /** Stable per source instance; hooks key their caches on it. */
  readonly id: string;
  summary(signal?: AbortSignal): Promise<EngagementSummary>;
  attendees(query: AttendeeQuery, signal?: AbortSignal): Promise<EngagementAttendeePage>;
  attendee(identity: string, signal?: AbortSignal): Promise<EngagementAttendeeDetail>;
  /** Plain download link; absent when there is nothing to download (sample data). */
  csvUrl?: string;
  /** Present only where recomputing means something (the real API). */
  recompute?(): Promise<EngagementSummary>;
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(what: string) {
    super(`${what} was not found.`);
    this.name = "NotFoundError";
  }
}

let world: { data: FixtureWorld; summary: EngagementSummary } | null = null;

/** Built once per module: 85 people × 60 minutes is cheap, but not free on every render. */
function sample() {
  if (!world) {
    const data = generateWorld();
    world = { data, summary: summarise(data) };
  }
  return world;
}

function abortable<T>(signal: AbortSignal | undefined, value: () => T): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  try {
    return Promise.resolve(value());
  } catch (e) {
    return Promise.reject(e);
  }
}

export function fixtureSource(): EngagementSource {
  return {
    id: "fixture",
    summary: (signal) => abortable(signal, () => sample().summary),
    attendees: (query, signal) =>
      abortable(signal, () => pageOf(sample().data.people.map((p) => p.detail.row), query, AXIS)),
    attendee: (identity, signal) =>
      abortable(signal, () => {
        const found = sample().data.people.find((p) => p.detail.row.identity === identity);
        if (!found) throw new NotFoundError("That attendee");
        return found.detail;
      }),
  };
}
