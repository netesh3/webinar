/* Which tabs a webinar's host screen offers, and how a ?tab= value maps onto them.
 *
 * Three tabs per stage, in the order a coach works: before the webinar Overview (the link,
 * the numbers, what goes out on its own, anyone waiting), People (who registered, pending
 * approvals first) and Setup (everything about how it runs). Live adds Results. After it,
 * Results (the Engagement dashboard), Follow up (the one place to message people after a
 * webinar) and Recording.
 *
 * Pure so node can test it: old links still say ?tab=report, ?tab=admit, ?tab=messages, and
 * a link that silently lands somewhere else is the kind of breakage nobody reports. */

import type { SectionId } from "./engagement/sections.ts";

export const PRE_EVENT_TABS = ["Overview", "People", "Setup"] as const;
export const ENDED_TABS = ["Results", "Follow up", "Recording"] as const;

export type HostTab =
  | (typeof PRE_EVENT_TABS)[number]
  | (typeof ENDED_TABS)[number];

export type HostStatus = "draft" | "scheduled" | "live" | "ended" | string;

/** The four steps of a webinar, and which one this status is on. */
export type Step = "create" | "invite" | "live" | "follow";
export function stepFor(status: HostStatus): Step {
  if (status === "draft") return "create";
  if (status === "live") return "live";
  if (status === "ended") return "follow";
  return "invite";
}

/* Follow up needs WhatsApp; without it an ended webinar has Results and Recording. Live
 * adds Results after the three, so the numbers are one click away while it runs. */
export function tabsFor(status: HostStatus, whatsapp = false): readonly HostTab[] {
  if (status === "ended") return whatsapp ? ENDED_TABS : ["Results", "Recording"];
  if (status === "live") return [...PRE_EVENT_TABS, "Results"];
  return PRE_EVENT_TABS;
}

/* Every ?tab= spelling ever linked to, onto today's tabs. The old names are the ones
 * emails, the bell and the Hosting list still send. */
const QUERY: Record<string, HostTab> = {
  overview: "Overview",
  share: "Overview",
  people: "People",
  admit: "People",
  registrants: "People",
  attendees: "People",
  attendance: "People",
  setup: "Setup",
  settings: "Setup",
  stage: "Setup",
  results: "Results",
  engagement: "Results",
  report: "Results",
  insights: "Results",
  analytics: "Results",
  survey: "Results",
  feedback: "Results",
  "follow up": "Follow up",
  "follow-up": "Follow up",
  followup: "Follow up",
  messages: "Follow up",
  recording: "Recording",
  recordings: "Recording",
};

/** On an ended webinar, links to tabs that became Results sections open that section. */
const RESULTS_SECTION: Record<string, SectionId> = {
  attendees: "attendees",
  attendance: "attendees",
  survey: "survey",
  feedback: "survey",
};

export function tabFromQuery(raw: string | null | undefined): HostTab | null {
  if (!raw) return null;
  return QUERY[raw.trim().toLowerCase()] ?? null;
}

/** An old link can ask for a tab this webinar does not have (yet, or any more); null lets
 *  the caller fall back. Before the end, Results and Follow up links open Overview; after
 *  it, People links open Results (its Attendees section) and Setup links fall back. */
export function allowedTab(tab: HostTab | null, status: HostStatus, whatsapp = false): HostTab | null {
  if (!tab) return null;
  const tabs = tabsFor(status, whatsapp);
  if (tabs.includes(tab)) return tab;
  if (status === "ended" && tab === "People") return "Results";
  if (status === "ended" && tab === "Follow up") return "Results";
  if (status !== "ended" && (tab === "Follow up" || tab === "Recording")) return "Overview";
  return null;
}

/** The Results section a ?tab= link means on an ended webinar, e.g. ?tab=survey. */
export function engagementSection(raw: string | null | undefined, status: HostStatus): SectionId | undefined {
  if (!raw || (status !== "ended" && status !== "live")) return undefined;
  const key = raw.trim().toLowerCase();
  if (status === "live" && (key === "attendees" || key === "attendance")) return undefined;
  return RESULTS_SECTION[key];
}

/** What opens when no (usable) ?tab= was given. */
export function defaultTab(
  status: HostStatus,
  { whatsapp = false, requested }: { pending?: number; whatsapp?: boolean; requested?: string | null },
): HostTab {
  const asked = allowedTab(tabFromQuery(requested), status, whatsapp);
  if (asked) return asked;
  return status === "ended" ? "Results" : "Overview";
}
