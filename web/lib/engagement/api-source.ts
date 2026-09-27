import { api } from "../api";
import type { EngagementSource } from "./source";

/** The real adapter: every call is the host endpoint of the same name in lib/api.ts. */
export function apiSource(slug: string): EngagementSource {
  return {
    id: `api:${slug}`,
    summary: (signal) => api.engagementSummary(slug, signal),
    attendees: (query, signal) => api.engagementAttendees(slug, query, signal),
    attendee: (identity, signal) => api.engagementAttendee(slug, identity, signal),
    csvUrl: api.engagementCsvUrl(slug),
    recompute: () => api.recomputeEngagement(slug),
  };
}
