import {
  SlotConfirmation,
  TimingAfterEnd,
  TimingBefore,
  TimingImmediate,
  TimingNextMorning,
  TimingOnPublish,
  type MessageTiming,
} from "@/lib/api-types";

/* Timing on the wire is not one shape: "before" sends minutes as a list,
 * "after_end" sends one number. The page always works with a list. */

export function minutesOf(timing: MessageTiming): number[] {
  const raw = timing.minutes as unknown;
  if (Array.isArray(raw)) return raw.filter((n) => Number.isFinite(n));
  if (typeof raw === "number" && Number.isFinite(raw)) return [raw];
  return [];
}

export function durationLabel(mins: number): string {
  if (mins % 1440 === 0 && mins !== 0) {
    const d = mins / 1440;
    return d === 1 ? "1 day" : `${d} days`;
  }
  if (mins % 60 === 0 && mins !== 0) {
    const h = mins / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (mins === 1) return "1 minute";
  return `${mins} minutes`;
}

/** The chip on a card: "1 day and 1 hour before", "2 hours after". */
export function timingLabel(kind: string, timing: MessageTiming): string {
  if (kind === SlotConfirmation || timing.type === TimingImmediate) {
    return "Right away";
  }
  if (timing.type === TimingBefore) {
    const parts = minutesOf(timing).map(durationLabel);
    if (parts.length === 0) return "Before it starts";
    if (parts.length === 1) return `${parts[0]} before`;
    return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]} before`;
  }
  if (timing.type === TimingOnPublish) return "When I publish the recording";
  if (timing.type === TimingNextMorning) {
    return `Next morning (${hourLabel(timing.hour ?? 9)})`;
  }
  if (timing.type === TimingAfterEnd) {
    const m = minutesOf(timing)[0] ?? 0;
    const when = durationLabel(m);
    return kind === "replay" ? `${when} after it ends` : `${when} after`;
  }
  return "When you choose";
}

export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

export function timingForSave(timing: MessageTiming): MessageTiming {
  if (timing.type === TimingBefore) {
    return { type: TimingBefore, minutes: minutesOf(timing) };
  }
  if (timing.type === TimingAfterEnd) {
    return { type: TimingAfterEnd, minutes: [minutesOf(timing)[0] ?? 0] };
  }
  if (timing.type === TimingNextMorning) {
    return { type: TimingNextMorning, hour: timing.hour ?? 9 };
  }
  if (timing.type === TimingOnPublish) return { type: TimingOnPublish };
  return { type: TimingImmediate };
}
