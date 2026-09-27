/* Where the Engagement page gets its data: one interface, two adapters.
 *
 * `fixtureSource()` (here) answers from the seeded sample webinar with the server's paging
 * semantics, so the page renders with no backend (dev bypass, /mock/engagement).
 * `apiSource(slug)` lives in api-source.ts, apart from this file, so node can test this one
 * without resolving the app's HTTP client. Components only ever see the interface. */

import type {
  AttendanceRow,
  EngagementAttendeeDetail,
  EngagementAttendeePage,
  EngagementSummary,
  SessionQuestion,
} from "../api-types.ts";
import { summarise } from "./fixture-summary.ts";
import { WEBINAR } from "./fixture-data.ts";
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
  /** The old Report's downloads, offered beside the engagement CSV in the Export menu. */
  attendanceCsvUrl?: string;
  chatCsvUrl?: string;
  transcriptUrl?: string;
  /** The attendance log's parts the engagement numbers leave out on purpose: the stage
   *  (hosts, panelists) and every question, not just the audience's top 50. Asked for only
   *  when the host opens one of those lists, so the tab's first paint costs no extra call. */
  record?(signal?: AbortSignal): Promise<SessionRecord>;
}

export interface SessionRecord {
  stage: AttendanceRow[];
  questions: SessionQuestion[];
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

/** `status` lets local preview show the tab's other states over the same sample: before the
 *  start (no numbers yet) and live (the auto-refresh banner). */
export function fixtureSource(status: "ended" | "live" | "scheduled" = "ended"): EngagementSource {
  const summaryFor = (): EngagementSummary => {
    const s = sample().summary;
    if (status === "ended") return s;
    if (status === "live") return { ...s, webinar: { ...s.webinar, status: "live", endedAt: undefined } };
    return {
      ...s,
      state: "not_started",
      webinar: { ...s.webinar, status: "scheduled", startedAt: undefined, endedAt: undefined },
    };
  };
  return {
    id: `fixture:${status}`,
    summary: (signal) => abortable(signal, summaryFor),
    attendees: (query, signal) =>
      abortable(signal, () => pageOf(sample().data.people.map((p) => p.detail.row), query, AXIS)),
    attendee: (identity, signal) =>
      abortable(signal, () => {
        const found = sample().data.people.find((p) => p.detail.row.identity === identity);
        if (!found) throw new NotFoundError("That attendee");
        return found.detail;
      }),
    record: (signal) =>
      abortable(signal, () => ({
        stage: SAMPLE_STAGE,
        questions: [
          ...sample().summary.questions.map((q) => ({
            id: q.id,
            name: q.name || "Anonymous",
            anonymous: !q.name,
            text: q.text,
            answered: q.answered,
            upvotes: q.upvotes,
            createdAt: new Date(Date.parse(WEBINAR.startedAt) + q.minute * 60_000).toISOString(),
            role: "attendee" as const,
          })),
          {
            id: "q-stage",
            name: "Rohan Mehta",
            text: "Priya, can you share the pricing worksheet in the follow-up?",
            answered: true,
            upvotes: 0,
            createdAt: "2026-09-22T13:47:00Z",
            role: "panelist" as const,
          },
        ],
      })),
  };
}

/* The sample webinar's stage: a host who was there throughout and a panelist who dropped
 * once, so the list's rejoin line has something to show. */
const SAMPLE_STAGE: AttendanceRow[] = [
  {
    identity: "user_sample_host",
    name: "Priya Sharma",
    email: "priya@example.com",
    role: "host",
    watchMin: 60,
    firstJoinedAt: "2026-09-22T12:52:00Z",
    lastLeftAt: "2026-09-22T14:02:00Z",
    visits: [{ joinedAt: "2026-09-22T12:52:00Z", leftAt: "2026-09-22T14:02:00Z", minutes: 60 }],
  },
  {
    identity: "user_sample_panelist",
    name: "Rohan Mehta",
    email: "rohan@example.com",
    role: "panelist",
    watchMin: 51,
    firstJoinedAt: "2026-09-22T12:58:00Z",
    lastLeftAt: "2026-09-22T14:00:00Z",
    visits: [
      { joinedAt: "2026-09-22T12:58:00Z", leftAt: "2026-09-22T13:31:00Z", minutes: 31 },
      { joinedAt: "2026-09-22T13:40:00Z", leftAt: "2026-09-22T14:00:00Z", minutes: 20 },
    ],
  },
];
