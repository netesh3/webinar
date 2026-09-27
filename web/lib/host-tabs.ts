/* Which tabs a webinar's host screen offers, and how a ?tab= value maps onto them.
 *
 * Pure so node can test it: old links still say ?tab=report, and a link that silently
 * lands somewhere else is the kind of breakage nobody reports. */

import type { SectionId } from "./engagement/sections.ts";

export const PRE_EVENT_TABS = [
  "Admit",
  "Attendees",
  "Share",
  "Stage",
  "Recordings",
  "Settings",
] as const;

/* After the end, Engagement is the one place for "how did it go": who came (its Attendees
 * section, with every person's timeline), and what they said (its Survey section). Separate
 * Attendees and Survey tabs only repeated it, so an ended webinar has neither, and links to
 * them open the matching Engagement section instead. */
export const ENDED_TABS = ["Engagement", "Recordings"] as const;

export type HostTab =
  | (typeof PRE_EVENT_TABS)[number]
  | (typeof ENDED_TABS)[number]
  | "Survey"
  | "Messages";

export type HostStatus = "draft" | "scheduled" | "live" | "ended" | string;

/* Engagement is the post-event view, so an ended webinar leads with it. Before that it is
 * still offered (last) — live it refreshes itself, and before the start it explains when
 * numbers will appear — except on a draft, which has nothing to measure yet. Messages is
 * Engage's tab, after Attendees (after Engagement once Attendees is gone), only where this
 * deployment can connect WhatsApp. */
export function tabsFor(status: HostStatus, whatsapp = false): readonly HostTab[] {
  const ended = status === "ended";
  let base: HostTab[] = ended ? [...ENDED_TABS] : [...PRE_EVENT_TABS];
  if (!ended && status !== "draft") base = [...base, "Engagement"];
  if (!whatsapp) return base;
  const i = base.indexOf(ended ? "Engagement" : "Attendees") + 1;
  return [...base.slice(0, i), "Messages", ...base.slice(i)];
}

const QUERY: Record<string, HostTab> = {
  admit: "Admit",
  registrants: "Admit",
  attendees: "Attendees",
  attendance: "Attendees",
  share: "Share",
  stage: "Stage",
  recordings: "Recordings",
  settings: "Settings",
  survey: "Survey",
  feedback: "Survey",
  messages: "Messages",
  engagement: "Engagement",
  // The tab this one replaced, and the words people used for it.
  report: "Engagement",
  insights: "Engagement",
  analytics: "Engagement",
};

/** Tabs folded into Engagement after the end, and the section each one became. */
const FOLDED_INTO_ENGAGEMENT: Partial<Record<HostTab, SectionId>> = {
  Attendees: "attendees",
  Survey: "survey",
};

export function tabFromQuery(raw: string | null | undefined): HostTab | null {
  if (!raw) return null;
  return QUERY[raw.trim().toLowerCase()] ?? null;
}

/** An old link can ask for a tab this webinar no longer has; null lets the caller fall back.
 *  On an ended webinar, Attendees and Survey links open Engagement. */
export function allowedTab(
  tab: HostTab | null,
  status: HostStatus,
  whatsapp = false,
): HostTab | null {
  if (!tab) return null;
  const tabs = tabsFor(status, whatsapp);
  if (tabs.includes(tab)) return tab;
  if (FOLDED_INTO_ENGAGEMENT[tab] && tabs.includes("Engagement")) return "Engagement";
  return null;
}

/** The Engagement section a ?tab= link means, e.g. ?tab=survey → its Survey section. */
export function engagementSection(raw: string | null | undefined, status: HostStatus): SectionId | undefined {
  const tab = tabFromQuery(raw);
  if (!tab || tabsFor(status).includes(tab)) return undefined;
  return FOLDED_INTO_ENGAGEMENT[tab];
}

/** What opens when no (usable) ?tab= was given. */
export function defaultTab(
  status: HostStatus,
  { pending, whatsapp = false, requested }: { pending: number; whatsapp?: boolean; requested?: string | null },
): HostTab {
  const asked = allowedTab(tabFromQuery(requested), status, whatsapp);
  if (asked) return asked;
  if (status === "ended") return "Engagement";
  return pending > 0 ? "Admit" : "Attendees";
}
