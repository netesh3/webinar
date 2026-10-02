import {
  AudienceContacts,
  AudienceSegment,
  AudienceTag,
  AudienceWebinar,
  PeopleAttended,
  PeopleHighlyEngaged,
  PeopleHotLeads,
  PeopleNeverAttended,
} from "../../lib/api-types.ts";

/* Words the Broadcasts tab shows for a real broadcast.
 *
 * Status, audience and language come from the API. A draft is not one of the
 * statuses, and a language code is written out ("English (US)") because that is
 * how a host reads a template, not how Meta stores it. */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sept",
  "Oct",
  "Nov",
  "Dec",
];

/** Meta's `en_US` as "English (US)". An unknown code is left as it arrived. */
export function languageLabel(code: string): string {
  const raw = code.trim();
  if (!raw) return "";
  const [lang, region] = raw.split("_");
  let language = lang || raw;
  try {
    const name = new Intl.DisplayNames("en", { type: "language" }).of(language);
    if (name && name.toLowerCase() !== language.toLowerCase()) language = name;
  } catch {
    /* Intl can reject a tag. The code is still the honest label. */
  }
  return region ? `${language} (${region})` : language;
}

/** "28 Sept, 10:12" in the reader's own zone. */
export function formatBroadcastStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hh}:${mm}`;
}

export function deliveryPercent(delivered: number, recipients: number): number {
  if (recipients <= 0 || delivered <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((delivered / recipients) * 100)));
}

/** Read as a percent of sent, once anything has gone out. */
export function readPercent(read: number, sent: number): string | null {
  if (sent <= 0) return null;
  return `${Math.round((read / sent) * 100)}%`;
}

export type AudienceBits = {
  audience: string;
  name?: string;
  tagName?: string;
  webinarTopic?: string;
  webinarId?: string;
  segmentLabel?: string;
};

/** The segment chip. The card title is the host's name; this is who it went to. */
export function audienceLabel(b: AudienceBits): string {
  if (b.audience === AudienceTag) {
    return `Everybody tagged ${b.tagName || "with one tag"}`;
  }
  if (b.audience === AudienceWebinar) {
    return `Registrants for ${b.webinarTopic || b.webinarId || "a webinar"}`;
  }
  if (b.audience === AudienceSegment || b.audience === AudienceContacts) {
    return b.segmentLabel || b.name || "Selected people";
  }
  return "Everyone who opted in";
}

export function broadcastTitle(b: AudienceBits): string {
  const name = (b.name ?? "").trim();
  return name || audienceLabel(b);
}

/** People-page groups, in the order the composer lists them.
 *  The label is also the broadcast's name, so a duplicate can select the same row. */
export const peopleAudienceLabels: Record<string, string> = {
  [PeopleAttended]: "Came",
  [PeopleNeverAttended]: "Didn't come",
  [PeopleHighlyEngaged]: "Highly engaged",
  [PeopleHotLeads]: "Hot leads",
};

export function peopleFilterForLabel(name: string): string {
  const want = name.trim();
  for (const [filter, label] of Object.entries(peopleAudienceLabels)) {
    if (label === want) return filter;
  }
  return "";
}

export type AudienceDraft = {
  /** locked is a segment or a hand-picked list the composer has no other row for. */
  kind: "opted_in" | "people" | "webinar" | "tag" | "locked";
  peopleFilter: string;
  webinarId: string;
  tagId: string;
};

/** How the new/edit drawer should open for a broadcast that already exists. */
export function audienceDraft(
  b: AudienceBits & { contactIds?: string[]; tagId?: string },
): AudienceDraft {
  const webinarId = b.webinarId ?? "";
  const tagId = b.tagId ?? "";
  if (b.audience === AudienceWebinar) {
    return { kind: "webinar", peopleFilter: "", webinarId, tagId: "" };
  }
  if (b.audience === AudienceTag) {
    return { kind: "tag", peopleFilter: "", webinarId, tagId };
  }
  if (b.audience === AudienceContacts) {
    const peopleFilter = peopleFilterForLabel(b.name ?? "");
    if (peopleFilter) {
      return { kind: "people", peopleFilter, webinarId, tagId: "" };
    }
    return { kind: "locked", peopleFilter: "", webinarId, tagId: "" };
  }
  if (b.audience === AudienceSegment) {
    return { kind: "locked", peopleFilter: "", webinarId, tagId: "" };
  }
  return { kind: "opted_in", peopleFilter: "", webinarId, tagId: "" };
}

export type BroadcastMenuAction = {
  id: "edit" | "duplicate" | "delete";
};

/** What the card's ⋯ menu offers.
 *
 * Edit only before anything has gone out. Sending can be deleted, which also
 * stops whatever is still waiting; it cannot be edited or copied mid-flight.
 * Sent, cancelled, failed and completed can be copied or removed from the list.
 */
export function broadcastMenuActions(status: string): BroadcastMenuAction[] {
  switch (status) {
    case "draft":
    case "scheduled":
      return [{ id: "edit" }, { id: "duplicate" }, { id: "delete" }];
    case "sending":
      return [{ id: "delete" }];
    default:
      return [{ id: "duplicate" }, { id: "delete" }];
  }
}

export function deleteBroadcastCopy(status: string): {
  title: string;
  body: string;
  confirm: string;
} {
  if (status === "draft" || status === "scheduled") {
    return {
      title: "Delete this broadcast?",
      body: "This takes it off your list and cancels the send. Anything still waiting will not go out.",
      confirm: "Delete broadcast",
    };
  }
  if (status === "sending") {
    return {
      title: "Delete this broadcast?",
      body: "Sending stops here. Anything still waiting will not go out. Messages already delivered stay in the chat, and this card comes off the list.",
      confirm: "Delete broadcast",
    };
  }
  return {
    title: "Delete this broadcast?",
    body: "This takes it off your list. Chats and attendee records stay as they are.",
    confirm: "Delete broadcast",
  };
}
