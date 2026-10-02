import {
  AudienceContacts,
  AudienceSegment,
  AudienceTag,
  AudienceWebinar,
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
