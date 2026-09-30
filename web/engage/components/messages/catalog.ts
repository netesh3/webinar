import {
  ChannelEmail,
  ChannelWhatsApp,
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder,
  NotifyWhatsAppReplay,
  SlotConfirmation,
  SlotFollowupEngaged,
  SlotFollowupHigh,
  SlotFollowupNoShow,
  SlotFollowupPassive,
  SlotFollowupRisk,
  SlotReminder,
  SlotReplay,
  TimingImmediate,
  TimingNextMorning,
  TimingOnPublish,
  type MessageSlot,
  type MessageSlotPatch,
  type NotificationKind,
} from "@/lib/api-types";
import { hourLabel } from "../message-timing";

/* The Messages tab's catalogue: one row per slot, in the order the mock shows them,
 * and the short "when" line each row prints. Timing words live here so the list and
 * the pane say the same thing. */

export type MessageGroup = "before" | "after";

export type MessageMeta = {
  kind: string;
  group: MessageGroup;
  title: string;
  icon: string;
  /** The pane's one-line "what this is", under the title. */
  blurb: string;
  /** A follow-up's purpose, appended to its when-line once a wording is chosen. */
  hint?: string;
};

export const MESSAGE_ROWS: MessageMeta[] = [
  {
    kind: SlotConfirmation,
    group: "before",
    title: "Confirmation",
    icon: "mark_email_read",
    blurb: "when they register",
  },
  {
    kind: SlotReminder,
    group: "before",
    title: "Reminder",
    icon: "alarm",
    blurb: "before it starts",
  },
  {
    kind: SlotReplay,
    group: "after",
    title: "Replay",
    icon: "play_circle",
    blurb: "after it ends",
  },
  {
    kind: SlotFollowupHigh,
    group: "after",
    title: "Highly engaged",
    icon: "local_fire_department",
    blurb: "after it ends",
    hint: "offer",
  },
  {
    kind: SlotFollowupNoShow,
    group: "after",
    title: "Didn't join",
    icon: "person_off",
    blurb: "after it ends",
    hint: "replay link",
  },
  {
    kind: SlotFollowupEngaged,
    group: "after",
    title: "Engaged",
    icon: "favorite",
    blurb: "after it ends",
    hint: "thank-you",
  },
  {
    kind: SlotFollowupPassive,
    group: "after",
    title: "Passive",
    icon: "visibility_off",
    blurb: "after it ends",
    hint: "recap",
  },
  {
    kind: SlotFollowupRisk,
    group: "after",
    title: "Left early",
    icon: "logout",
    blurb: "after it ends",
    hint: "replay",
  },
];

export function metaFor(kind: string): MessageMeta | undefined {
  return MESSAGE_ROWS.find((row) => row.kind === kind);
}

export function isFollowup(kind: string): boolean {
  return kind.startsWith("followup_");
}

/** No wording resolved from any layer (builtin, default, options or webinar) —
 *  truly nothing to send yet. Opening the row lands on the wording list. */
export function unconfigured(slot: MessageSlot | undefined): boolean {
  return Boolean(slot && !slot.template);
}

export function wordingKind(kind: string): NotificationKind {
  switch (kind) {
    case SlotConfirmation:
      return NotifyWhatsAppConfirmed;
    case SlotReminder:
      return NotifyWhatsAppReminder;
    case SlotReplay:
      return NotifyWhatsAppReplay;
    default:
      return "";
  }
}

function amount(total: number): string {
  if (total >= 1440 && total % 1440 === 0) {
    const days = total / 1440;
    return days === 1 ? "1 day" : `${days} days`;
  }
  if (total >= 60 && total % 60 === 0) {
    const hours = total / 60;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return total === 1 ? "1 minute" : `${total} minutes`;
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "1 day and 1 hour before" — the reminder row's when-line. */
export function reminderWhen(minutes: number[] | undefined): string {
  const list = [...(minutes ?? [])].filter((n) => n > 0).sort((a, b) => b - a);
  if (list.length === 0) return "no times chosen";
  return `${joinAnd(list.map(amount))} before`;
}

/** "1 hour after", "next day" — replay and follow-ups. */
export function laterWhen(slot: MessageSlot): string {
  if (slot.timing.type === TimingOnPublish) return "when you publish the recording";
  if (slot.timing.type === TimingImmediate) return "when they register";
  if (slot.timing.type === TimingNextMorning) {
    return `next morning, ${hourLabel(slot.timing.hour ?? 9)}`;
  }
  const minutes = slot.timing.minutes?.[0] ?? 0;
  if (minutes <= 0) return "when it ends";
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "next day" : `${days} days after`;
  }
  return `${amount(minutes)} after`;
}

/** The row's second line: when it goes, and what a follow-up is for. */
export function rowWhen(slot: MessageSlot | undefined, meta: MessageMeta): string {
  if (!slot) return meta.blurb;
  if (slot.kind === SlotConfirmation) return "when they register";
  if (slot.kind === SlotReminder) return reminderWhen(slot.timing.minutes);
  const when = laterWhen(slot);
  if (meta.hint && slot.template) return `${when} · ${meta.hint}`;
  return when;
}

export function hasChannel(slot: MessageSlot | undefined, channel: string): boolean {
  return Boolean(slot?.channels.includes(channel));
}

const CHANNEL_ORDER = [ChannelEmail, ChannelWhatsApp];

export function withChannel(
  slot: MessageSlot,
  channel: string,
  on: boolean,
): MessageSlot {
  const channels = CHANNEL_ORDER.filter((item) =>
    item === channel ? on : slot.channels.includes(item),
  );
  return { ...slot, channels };
}

/** The whole slot, as a webinar override. Omitted fields would inherit instead. */
export function toPatch(slot: MessageSlot): MessageSlotPatch {
  return {
    kind: slot.kind,
    channels: slot.channels ?? [],
    timing: slot.timing,
    template: slot.template ?? "",
    language: slot.language ?? "",
    params: slot.params ?? [],
    enabled: slot.enabled,
  };
}

/** An empty override: this webinar inherits the account default, including past
 *  the legacy reminder options, which only apply when no settings row exists. */
export function clearPatch(kind: string): MessageSlotPatch {
  return { kind };
}

export function slotReady(slot: MessageSlot): string | null {
  if (slot.kind === SlotReminder && (slot.timing.minutes?.length ?? 0) === 0) {
    return "Choose at least one reminder time.";
  }
  return null;
}

/* after_end is one number on the wire and a list everywhere else. The editor
 * always keeps a list, so a response is normalised before it reaches a row. */
export function normalizeSlot(slot: MessageSlot): MessageSlot {
  const minutes = slot.timing?.minutes as unknown;
  const list = Array.isArray(minutes)
    ? minutes
    : typeof minutes === "number"
      ? [minutes]
      : [];
  return {
    ...slot,
    channels: slot.channels ?? [],
    params: slot.params ?? [],
    timing: { ...slot.timing, minutes: list },
  };
}

export function normalizeSlots(slots: MessageSlot[]): MessageSlot[] {
  return slots.map(normalizeSlot);
}
