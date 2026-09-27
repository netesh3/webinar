/* Which tabs a webinar's host screen offers, and how a ?tab= value maps onto them.
 *
 * Pure so node can test it: old links still say ?tab=report, and a link that silently
 * lands somewhere else is the kind of breakage nobody reports. */

export const PRE_EVENT_TABS = [
  "Admit",
  "Attendees",
  "Share",
  "Stage",
  "Recordings",
  "Settings",
] as const;

export const ENDED_TABS = ["Engagement", "Recordings", "Attendees"] as const;

export type HostTab =
  | (typeof PRE_EVENT_TABS)[number]
  | (typeof ENDED_TABS)[number]
  | "Messages";

export type HostStatus = "draft" | "scheduled" | "live" | "ended" | string;

/* Engagement is the post-event view, so an ended webinar leads with it. Before that it is
 * still offered (last) — live it refreshes itself, and before the start it explains when
 * numbers will appear — except on a draft, which has nothing to measure yet. Messages is
 * Engage's tab, after Attendees, only where this deployment can connect WhatsApp. */
export function tabsFor(status: HostStatus, whatsapp = false): readonly HostTab[] {
  const ended = status === "ended";
  let base: HostTab[] = ended ? [...ENDED_TABS] : [...PRE_EVENT_TABS];
  if (!ended && status !== "draft") base = [...base, "Engagement"];
  if (!whatsapp) return base;
  const i = base.indexOf("Attendees") + 1;
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
  messages: "Messages",
  engagement: "Engagement",
  // The tab this one replaced, and the words people used for it.
  report: "Engagement",
  insights: "Engagement",
  analytics: "Engagement",
};

export function tabFromQuery(raw: string | null | undefined): HostTab | null {
  if (!raw) return null;
  return QUERY[raw.trim().toLowerCase()] ?? null;
}

/** An old link can ask for a tab this webinar no longer has; null lets the caller fall back. */
export function allowedTab(
  tab: HostTab | null,
  status: HostStatus,
  whatsapp = false,
): HostTab | null {
  return tab && tabsFor(status, whatsapp).includes(tab) ? tab : null;
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
