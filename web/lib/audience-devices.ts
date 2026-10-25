import type { AudienceDevices, DeviceCount } from "./api-types";

/* The audience-by-device breakdown as the cards show it (components/audience-devices.tsx):
 * a label, a count and a share of the people whose device is known, largest first. Pure, so
 * the rounding and the wording are tested (audience-devices.test.mts). */

const CLASS_LABEL: Record<string, string> = {
  phone: "Phone",
  tablet: "Tablet",
  desktop: "Desktop",
};

export interface DeviceRow {
  key: string;
  label: string;
  count: number;
  /** Whole percent of the people whose device is known. */
  pct: number;
}

function label(key: string): string {
  return CLASS_LABEL[key] ?? (key === "other" || key === "" ? "Other" : key);
}

export function deviceRows(counts: DeviceCount[], recorded: number): DeviceRow[] {
  return counts.map((c) => ({
    key: c.key,
    label: label(c.key),
    count: c.count,
    pct: recorded > 0 ? Math.round((c.count / recorded) * 100) : 0,
  }));
}

/** The line under the heading: how many people the numbers cover, and why some may be missing. */
export function devicesNote(d: AudienceDevices): string {
  if (d.attendees === 0) return "Nobody has joined yet.";
  const people = (n: number) => `${n.toLocaleString("en-IN")} ${n === 1 ? "person" : "people"}`;
  if (d.recorded === d.attendees) return `${people(d.recorded)}, counted once each on the device they first joined on.`;
  const missing = d.attendees - d.recorded;
  return `${people(d.recorded)} of ${d.attendees.toLocaleString("en-IN")} — ${missing.toLocaleString("en-IN")} joined before devices were recorded, or only through the video server.`;
}
